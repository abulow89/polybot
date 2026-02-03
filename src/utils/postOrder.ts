import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);

const FAST_ATTEMPTS = 2; // number of attempts before cooldown applies
// ======== COOLDOWN HELPERS ========
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const ORDERBOOK_DELAY = 350;
const ORDER_POST_DELAY = 600;
const RETRY_DELAY = 1200;
// ==================================
// ======== ADDED: sleepWithJitter ========
const sleepWithJitter = async (ms: number) => {
    const jitter = ms * 0.1 * (Math.random() - 0.5); // ±10% jitter
    await sleep(ms + jitter);
};
// ======== ADDED: adaptiveDelay ========
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
// ===========================================

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {

    // ======== NEW CANONICAL IDS ========
    const marketId = trade.conditionId; // ✅ ADDED: use for fees / market info
    const tokenId = trade.asset;        // ✅ ADDED: use for order book & orders
    // ===================================
    
    // ================= FETCH MARKET INFO FOR FEES =================
    let feeRateBps: number = 1000;
    try {
        const market = await safeCall(() => clobClient.getMarket(marketId));
        if (!market) {
            console.warn(`[CLOB] Market not found for ${marketId}. Using 1000 fees.`);
        }
        feeRateBps = market?.makerFeeRateBps ?? market?.takerFeeRateBps ?? 1000;
    } catch (err: unknown) {
        if (process.env.DEBUG_FEES) {
            if (err instanceof Error) {
                console.warn(`[CLOB] Could not fetch market fee for ${marketId}, using 1000`, err.message);
            } else {
                console.warn(`[CLOB] Could not fetch market fee for ${marketId}, using 1000`, err);
            }
        }
    }

    // ================= MERGE =================
    if (condition === 'merge') {
        console.log('Merging Strategy...');
        if (!my_position || my_position.asset !== tokenId) {
            console.log('No matching position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;
        let retry = 0;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remaining)); // only delay after fast attempts

            const orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('No bids found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce(
                (max, current) =>
                    parseFloat(current.price) > parseFloat(max.price) ? current : max,
                orderBook.bids[0]
            );

            console.log('Max price bid:', maxPriceBid);

            const sizeToSell = Math.min(remaining, parseFloat(maxPriceBid.size));
            const order_args = {
                side: Side.SELL,
                tokenID: tokenId,
                amount: sizeToSell,
                price: parseFloat(maxPriceBid.price),
                feeRateBps: feeRateBps
            };

            console.log('Order args:', order_args);

            const signedOrder = await safeCall(() => clobClient.createMarketOrder(order_args));
            const resp = await safeCall(() => clobClient.postOrder(signedOrder, OrderType.FOK));

            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDER_POST_DELAY, sizeToSell)); // replaced sleep

            if (resp.success) {
                console.log('Successfully posted order:', resp);
                remaining -= sizeToSell;
                retry = 0;
            } else {
                console.log('Error posting order: retrying...', resp);
                retry++;
                if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY); // skip cooldown for first 2 attempts
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    // ================= BUY =================
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);
        let retry = 0;

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
             if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remainingUSDC));
            const orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));

            if (!orderBook.asks || orderBook.asks.length === 0) {
                console.log('No asks found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce(
                (min, current) =>
                    parseFloat(current.price) < parseFloat(min.price) ? current : min,
                orderBook.asks[0]
            );

            console.log('Min price ask:', minPriceAsk);

        const targetPrice = Number(trade.price.toFixed(2)); // 🔧 MODIFIED (rounded)
            const feeMultiplier = 1 + feeRateBps / 10000;
            const effectivePrice = Math.round(askPrice * feeMultiplier * 100) / 100; // price including fee rounded
                    
            // Calculate shares we can actually afford including fee
        let affordableShares = remainingUSDC / effectivePrice;
        let sharesToBuy = Math.max(1, Math.min(affordableShares, parseFloat(minPriceAsk.size)));
          // ✅ Convert to integer BEFORE creating the signed order
            sharesToBuy = Math.floor(sharesToBuy);
        // =====================================
            
            if (Math.abs(AskPrice - targetPrice) > 0.05) {
                console.log('Ask price too far from target — skipping');
                break;
            }

            const order_args = {
                side: Side.BUY,
                tokenID: tokenId,
                amount: sharesToBuy, // ✅ converted to integer
                price: effectivePrice,
                feeRateBps: feeRateBps
            };
            
            const signedOrder = await safeCall(() => clobClient.createMarketOrder(order_args));
            const rawOrder = signedOrder;

// --- LOGGING ---
console.log('--- ORDER DEBUG ---');
console.log('Order args (input):', order_args);
console.log('Signed order (rawOrder):', JSON.stringify(rawOrder, null, 2));
console.log('makerAmount:', (rawOrder as any).makerAmount); // ➕ ADDED safe cast
console.log('takerAmount:', (rawOrder as any).takerAmount);
console.log('-------------------');

            const resp = await safeCall(() => clobClient.postOrder(signedOrder, OrderType.FOK));

          if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDER_POST_DELAY, sharesToBuy));


            if (resp.success) {
                console.log('Successfully posted order:', resp);
                remainingUSDC -= sharesToBuy * effectivePrice; // subtract total including fee
                retry = 0;
            } else {
                console.log('Error posting order: retrying...', resp);
                retry++;
                if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    // ================= SELL =================
    else if (condition === 'sell') {
        console.log('Sell Strategy...');
        if (!my_position) {
            console.log('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let remaining = my_position.size;
        if (user_position) {
            const ratio = trade.size / (user_position.size + trade.size);
            remaining *= ratio;
        }

        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remaining));
            const orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('No bids found');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce(
                (max, current) =>
                    parseFloat(current.price) > parseFloat(max.price) ? current : max,
                orderBook.bids[0]
            );

            console.log('Max price bid:', maxPriceBid);

            let sizeToSell = Math.floor(Math.min(remaining, parseFloat(maxPriceBid.size)));
            
            const price = Number(parseFloat(maxPriceBid.price).toFixed(2)); // 🔧 MODIFIED (rounded)

            const order_args = {
                side: Side.SELL,
                tokenID: tokenId,
                amount: sizeToSell, // ✅ converted to integer
                price: price,
                feeRateBps: feeRateBps
            };

            const signedOrder = await safeCall(() => clobClient.createMarketOrder(order_args));
            const rawOrder = signedOrder; // <-- define rawOrder here
            
            // --- LOGGING ---
console.log('--- SELL ORDER DEBUG ---');
console.log('Order args (input):', order_args);
console.log('Signed order (rawOrder):', JSON.stringify(rawOrder, null, 2));
console.log('makerAmount:', (rawOrder as any).makerAmount); // ➕ ADDED safe cast
console.log('takerAmount:', (rawOrder as any).takerAmount);
console.log('Price:', order_args.price);
console.log('Side:', order_args.side);
console.log('------------------------');
            
            const resp = await safeCall(() => clobClient.postOrder(signedOrder, OrderType.FOK));
            
            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDER_POST_DELAY, sizeToSell));

            if (resp.success) {
                console.log('Successfully posted order:', resp);
                remaining -= sizeToSell;
                retry = 0;
            } else {
                console.log('Error posting order: retrying...', resp);
                retry++;
                if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } else {
        console.log('Condition not supported');
    }
};

export default postOrder;
