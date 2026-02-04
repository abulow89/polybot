import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

// ===== EXCHANGE FORMAT HELPERS =====
const clampPrice = (p: number) => Math.min(0.999, Math.max(0.001, p));
const formatPriceForOrder = (p: number) => Math.round(clampPrice(p) * 1000) / 1000; // 3 decimals max
const formatMakerAmount = (a: number) => Math.floor(a * 100) / 100; // 2 decimals max

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);

const FAST_ATTEMPTS = 2;
// ======== ROUND SHARE HELPER ======
const roundShares = (x: number) => Math.floor(x * 10000) / 10000; // 4 decimal precision
// ======== COOLDOWN HELPERS ========
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const ORDERBOOK_DELAY = 350;
const RETRY_DELAY = 1200;

const sleepWithJitter = async (ms: number) => {
    const jitter = ms * 0.1 * (Math.random() - 0.5);
    await sleep(ms + jitter);
};

const adaptiveDelay = (baseDelay: number, scale: number) => {
    const factor = Math.min(2, Math.max(0.5, scale / 100));
    return baseDelay * factor;
};

// ========= RPC/API SAFETY WRAPPER =========
const safeCall = async <T>(fn: () => Promise<T>, retries = 3): Promise<T> => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e: any) {
            const retryable = e?.code === 'CALL_EXCEPTION' || e?.code === 'SERVER_ERROR' || e?.message?.includes('timeout');
            if (!retryable || i === retries - 1) throw e;
            console.log(`[RPC RETRY] Attempt ${i + 1} failed, retrying...`);
            await sleep(600);
        }
    }
    throw new Error('Unreachable safeCall state');
};

// ======== EXPOSURE TRACKING ========
// Tracks net shares owned per token (local to this module)
const exposure: Record<string, number> = {};

const updateExposure = (tokenId: string, side: Side, filled: number) => {
    if (!exposure[tokenId]) exposure[tokenId] = 0;
    exposure[tokenId] += side === Side.BUY ? filled : -filled;
    console.log(`[Exposure] Token ${tokenId}: ${exposure[tokenId]} shares`);
};
// 🔥 ADDED: GTC AUTO-CANCELLATION ENGINE
const CANCEL_THRESHOLD_MS = 5000; // cancel micro-orders older than 5s
// ✅ MODIFIED: Added explicit type for orders array, removed unnecessary array creation
interface ActiveOrder {
    id: string;
    tokenID: string;
    side: Side;
    size: number;
    price: number;
    createdAt: number;
}
const cancelStaleOrders = async (clobClient: ClobClient) => {
    try {
        // ✅ MODIFIED: Added explicit type for orders array, removed unnecessary array creation
interface ActiveOrder {
    id: string;
    tokenID: string;
    side: Side;
    size: number;
    price: number;
    createdAt: number;
}
    } catch (err) {
        console.error('Error in cancelStaleOrders:', err);
    }
};
// ======== HELPER: POST SINGLE ORDER ========
const postSingleOrder = async (
    clobClient: ClobClient,
    side: Side,
    tokenId: string,
    amountRaw: number,
    priceRaw: number,
    feeRateBps: number
) => {
const amount = Math.max(0.0001, roundShares(amountRaw));

const order_args = {
    side,
    tokenID: tokenId,
    size: amount, // ✅ change amount → size
    price: formatPriceForOrder(priceRaw * (1 + feeRateBps / 10000)),
    feeRateBps
};

console.log('--- ORDER DEBUG ---');
console.log('Order args:', order_args);

// ✅ NOW create the order
const signedOrder = await safeCall(() => clobClient.createOrder(order_args));

// ✅ NOW these values exist
console.log('makerAmount:', (signedOrder as any).makerAmount);
console.log('takerAmount:', (signedOrder as any).takerAmount);

const notional = amount * priceRaw;

const orderType = notional >= 1
    ? OrderType.FOK   // remove liquidity
    : OrderType.GTC;  // add liquidity

console.log(`[OrderType] ${orderType} | Notional: $${notional.toFixed(4)}`);

const resp = await safeCall(() => clobClient.postOrder(signedOrder, orderType));

if (!resp.success) console.log('Error posting order:', resp.error ?? resp);
else console.log('Successfully posted order');
    // 🔥 ADDED: cancel stale micro-orders after posting GTC
    if (orderType === OrderType.GTC) await cancelStaleOrders(clobClient);
        console.log('-------------------');

if (resp.success) updateExposure(tokenId, side, amount);

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

    let market;
    try {
        market = await safeCall(() => clobClient.getMarket(marketId));
    } catch (err) {
        console.warn(`[CLOB] Could not fetch market fee for ${marketId}, using 0`, err);
        market = { taker_base_fee: 0 };
    }
    console.log('Market info:', market);
    const feeRateBps = market?.taker_base_fee ?? 0;
    const feeMultiplier = 1 + feeRateBps / 10000;
    console.log(`[CLOB] Using feeRateBps: ${feeRateBps}, feeMultiplier: ${feeMultiplier}`);

    console.log(`[Balance] My balance: ${my_balance}, User balance: ${user_balance}`);
    
///// ======== SELL / MERGE ========//////////////////////////////////////////////////////////////////////////////////////////////////
   
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

            let orderBook;
            try {
                orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));
                if (!orderBook || !orderBook.bids?.length) {
                    console.log(`No bids for token ${tokenId}, skipping sell`);
                    break;
                }
            } catch (err: any) {
                if (err.response?.status === 404) {
                    console.log(`Token ${tokenId} has no orderbook yet, skipping`);
                    break;
                }
                throw err;
            }

            const maxPriceBid = orderBook.bids.reduce(
                (max, cur) => parseFloat(cur.price) > parseFloat(max.price) ? cur : max,
                orderBook.bids[0]
            );

            const sizeToSell =
                Math.max(0.0001,
                Math.floor(Math.min(remaining, parseFloat(maxPriceBid.size)) * 10000) / 10000
            );

            const filled = await postSingleOrder(
                clobClient,
                Side.SELL,
                tokenId,
                sizeToSell,
                parseFloat(maxPriceBid.price),
                feeRateBps
            );

            if (!filled) retry++;
            else {
                remaining -= filled;
                retry = 0;
            }

            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
        }

        await updateActivity();
    }

////// ======== BUY ========////////////////////////////////////////////////////////////////////////////////////////////////////
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);
        let retry = 0;

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remainingUSDC));

            let orderBook;
            try {
                orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));
                if (!orderBook || !orderBook.asks?.length) {
                    console.log(`No asks for token ${tokenId}, skipping buy`);
                    break;
                }
            } catch (err: any) {
                if (err.response?.status === 404) {
                    console.log(`Token ${tokenId} has no orderbook yet, skipping`);
                    break;
                }
                throw err;
            }

            console.log(`Orderbook for token ${tokenId}: top bid ${orderBook.bids?.[0]?.price} (${orderBook.bids?.[0]?.size}), top ask ${orderBook.asks?.[0]?.price} (${orderBook.asks?.[0]?.size})`);

            const minPriceAsk = orderBook.asks.reduce(
                (min, cur) => parseFloat(cur.price) < parseFloat(min.price) ? cur : min,
                orderBook.asks[0]
            );

            const askPriceRaw = parseFloat(minPriceAsk.price);
            const askSize = parseFloat(minPriceAsk.size);

            if (isNaN(askSize) || askSize <= 0) break;
            if (Math.abs(askPriceRaw - trade.price) > 0.05) break;

            let affordableShares = remainingUSDC / (askPriceRaw * feeMultiplier);
            let sharesToBuy = Math.min(affordableShares, askSize);
                sharesToBuy = Math.max(0.0001, Math.floor(sharesToBuy * 10000) / 10000);

            console.log('sharesToBuy:', sharesToBuy);

            let filled = 0;
            try {
                filled = await postSingleOrder(
                    clobClient,
                    Side.BUY,
                    tokenId,
                    sharesToBuy,
                    askPriceRaw,
                    feeRateBps
                );
            } catch (err: any) {
                if (err.response?.data?.error) console.log(`Order failed: ${err.response.data.error}`);
                else console.log('Order failed:', err.message || err);
            }

            if (!filled) retry++;
            else {
                remainingUSDC -= filled * askPriceRaw * feeMultiplier;
                retry = 0;
            }

            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
        }

        await updateActivity();
    } else {
        console.log('Condition not supported');
    }
};

export default postOrder;
