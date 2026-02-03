import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

// ===== EXCHANGE FORMAT HELPERS =====
const clampPrice = (p: number) => Math.min(0.999, Math.max(0.001, p));
const formatPriceForOrder = (p: number) =>
    Math.round(clampPrice(p) * 1000) / 1000; // 3 decimals max
const formatMakerAmount = (a: number) =>
    Math.floor(a * 100) / 100; // 2 decimals max

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);

const FAST_ATTEMPTS = 2; // attempts before cooldown

// ======== COOLDOWN HELPERS ========
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const ORDERBOOK_DELAY = 350;
const ORDER_POST_DELAY = 600;
const RETRY_DELAY = 1200;

const sleepWithJitter = async (ms: number) => {
    const jitter = ms * 0.1 * (Math.random() - 0.5); // ±10% jitter
    await sleep(ms + jitter);
};

const adaptiveDelay = (baseDelay: number, scale: number) => {
    const factor = Math.min(2, Math.max(0.5, scale / 100)); // scale 0.5x–2x
    return baseDelay * factor;
};

// ========= RPC/API SAFETY WRAPPER =========
const safeCall = async <T>(fn: () => Promise<T>, retries = 3): Promise<T> => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e: any) {
            const retryable =
                e?.code === 'CALL_EXCEPTION' ||
                e?.code === 'SERVER_ERROR' ||
                e?.message?.includes('missing revert data') ||
                e?.message?.includes('Internal error') ||
                e?.message?.includes('timeout');

            if (!retryable || i === retries - 1) throw e;

            console.log(`[RPC RETRY] Attempt ${i + 1} failed, retrying...`);
            await sleep(600);
        }
    }
    throw new Error('Unreachable safeCall state');
};

// ======== HELPER: POST SINGLE ORDER ========
const postSingleOrder = async (
    clobClient: ClobClient,
    side: Side,
    tokenId: string,
    amountRaw: number,
    priceRaw: number,
    marketId: string,
    tradeId: string
) => {
    // fetch market fee
    let feeRateBps = 0;
    try {
        const market = await safeCall(() => clobClient.getMarket(marketId));
        feeRateBps = market?.takerFeeRateBps ?? 0;
    } catch (err) {
        console.warn(`[CLOB] Could not fetch market fee for ${marketId}, using 0`, err);
        feeRateBps = 0;
    }

    // enforce minimum 1 share
    const amount = Math.max(1, Math.floor(amountRaw));

    const order_args = {
        side,
        tokenID: tokenId,
        amount,
        price: formatPriceForOrder(priceRaw * (1 + feeRateBps / 10000)),
        feeRateBps
    };

    console.log('--- ORDER DEBUG ---');
    console.log('Order args:', order_args);

    const signedOrder = await safeCall(() => clobClient.createMarketOrder(order_args));

    console.log('Signed order:', JSON.stringify(signedOrder, null, 2));
    console.log('makerAmount:', (signedOrder as any).makerAmount);
    console.log('takerAmount:', (signedOrder as any).takerAmount);
    console.log('-------------------');

    const resp = await safeCall(() => clobClient.postOrder(signedOrder, OrderType.FOK));

    if (!resp.success) console.log('Error posting order: retrying...', resp);
    else console.log('Successfully posted order:', resp);

    return resp.success ? amount : 0;
};

// ======== MAIN POST ORDER FUNCTION ========
const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {
    const marketId = trade.conditionId;
    const tokenId = trade.asset;

    let retry = 0;

    const updateActivity = async () => {
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    };

    const orderBookFetch = async () => await safeCall(() => clobClient.getOrderBook(tokenId));

    // ======== MERGE / SELL LOGIC ========
    if (condition === 'merge' || condition === 'sell') {
        console.log(`${condition === 'merge' ? 'Merging' : 'Sell'} Strategy...`);
        if (!my_position) {
            console.log('No position to sell/merge');
            await updateActivity();
            return;
        }

        let remaining = my_position.size;

        if (condition === 'sell' && user_position) {
            const ratio = trade.size / (user_position.size + trade.size);
            remaining *= ratio;
        }

        while (remaining > 0 && retry < RETRY_LIMIT) {
            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remaining));

            const orderBook = await orderBookFetch();
            if (!orderBook.bids?.length) break;

            const maxPriceBid = orderBook.bids.reduce(
                (max, cur) => parseFloat(cur.price) > parseFloat(max.price) ? cur : max,
                orderBook.bids[0]
            );

            const sizeToSell = Math.min(remaining, parseFloat(maxPriceBid.size));
            const filled = await postSingleOrder(clobClient, Side.SELL, tokenId, sizeToSell, parseFloat(maxPriceBid.price), marketId, trade._id.toString());

            if (!filled) retry++;
            else {
                remaining -= filled;
                retry = 0;
            }

            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
        }

        await updateActivity();
    }

    // ======== BUY LOGIC ========
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remainingUSDC));

            const orderBook = await orderBookFetch();
            if (!orderBook.asks?.length) break;

            const minPriceAsk = orderBook.asks.reduce(
                (min, cur) => parseFloat(cur.price) < parseFloat(min.price) ? cur : min,
                orderBook.asks[0]
            );

            const askPriceRaw = parseFloat(minPriceAsk.price);
            const targetPriceRaw = trade.price;

            if (Math.abs(askPriceRaw - targetPriceRaw) > 0.05) {
                console.log('Ask price too far from target — skipping');
                break;
            }

            const affordableShares = remainingUSDC / (askPriceRaw * (1 + (await safeCall(() => clobClient.getMarket(marketId))).takerFeeRateBps / 10000));
            const sharesToBuy = Math.min(affordableShares, parseFloat(minPriceAsk.size));

            const filled = await postSingleOrder(clobClient, Side.BUY, tokenId, sharesToBuy, askPriceRaw, marketId, trade._id.toString());
            if (!filled) retry++;
            else {
                remainingUSDC -= filled * askPriceRaw * (1 + (await safeCall(() => clobClient.getMarket(marketId))).takerFeeRateBps / 10000);
                retry = 0;
            }

            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
        }

        await updateActivity();
    }

    else {
        console.log('Condition not supported');
    }
};

export default postOrder;
