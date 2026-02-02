import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const MAX_SLIPPAGE = 0.05;
const PRICE_NUDGE = 0.001;

const API_COOLDOWN = 400;
const RETRY_BACKOFF = 700;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

 

let lastCall = 0;
const rateLimit = async () => {
    const now = Date.now();
    const diff = now - lastCall;
    if (diff < API_COOLDOWN) {
        await sleep(API_COOLDOWN - diff);
    }
    lastCall = Date.now();
};

const UserActivity = getUserActivityModel(USER_ADDRESS);

const getOrderBookSafe = async (
    clobClient: ClobClient,
    tokenID: string,
    tradeId: string
) => {
    await rateLimit();

    try {
        return await clobClient.getOrderBook(tokenID);
    } catch (err: any) {
        if (err?.response?.status === 404) {
            console.log('No CLOB market for token — skipping permanently');
            await UserActivity.updateOne({ _id: tradeId }, { bot: true });
            return null;
        }

        if (err?.response?.status === 429) {
            console.log('Rate limited. Cooling down...');
            await sleep(3000);
            return null;
        }

        throw err;
    }
};

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {

// ================= FETCH MARKET INFO FOR FEES =================
let feeRateBps: number = 0;
try {
    const market = await clobClient.getMarket(trade.asset);
    if (!market) {
        console.warn(`[CLOB] Market not found for ${trade.asset}. Using 0 fees.`);
    }
    feeRateBps = market?.makerFeeRateBps ?? market?.takerFeeRateBps ?? 0;
} catch (err: unknown) {
    if (process.env.DEBUG_FEES) {
        if (err instanceof Error) {
            console.warn(`[CLOB] Could not fetch market fee for ${trade.asset}, using 0`, err.message);
        } else {
            console.warn(`[CLOB] Could not fetch market fee for ${trade.asset}, using 0`, err);
        }
    }
}

   
    // ================= MERGE =================
    if (condition === 'merge') {
        console.log('Merging Strategy...');
        if (!my_position || my_position.asset !== trade.asset) {
            console.log('No matching position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let remaining = my_position.size;
        let retry = 0;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook || !orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const bidPrice = Math.max(0, parseFloat(bestBid.price) - PRICE_NUDGE);
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

            const order_args = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount: sizeToSell,
                price: bidPrice,
                feeRateBps: feeRateBps
            };

            console.log('Order args:', order_args);

            await rateLimit();
            const signedOrder = await clobClient.createMarketOrder(order_args);

            await rateLimit();
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
                console.log('Successfully posted order:', resp);
                await sleep(API_COOLDOWN);
            } else {
                retry++;
                const delay = API_COOLDOWN + retry * RETRY_BACKOFF;
                console.log(`Order failed. Retry ${retry}. Cooling ${delay}ms`);
                await sleep(delay);
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
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook || !orderBook.asks?.length) break;

            const bestAsk = orderBook.asks.reduce((a: any, b: any) =>
                parseFloat(b.price) < parseFloat(a.price) ? b : a
            );

            const rawAsk = parseFloat(bestAsk.price);
            if (Math.abs(rawAsk - trade.price) > MAX_SLIPPAGE) {
                console.log('Ask price too far from target — skipping');
                break;
            }

            const askPrice = rawAsk + PRICE_NUDGE;

            const maxSharesAtLevel = parseFloat(bestAsk.size);
            const affordableShares = remainingUSDC / askPrice;

let sharesToBuy = Math.min(maxSharesAtLevel, affordableShares);

// ✅ Convert to integer
sharesToBuy = Math.floor(sharesToBuy); // drops fractions
if (sharesToBuy <= 0) break;

            const order_args = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: sharesToBuy,
                price: askPrice,
                feeRateBps: feeRateBps
            };

            console.log('Min price ask:', bestAsk);
            console.log('Order args:', order_args);

            await rateLimit();
            const signedOrder = await clobClient.createMarketOrder(order_args);

            await rateLimit();
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remainingUSDC -= sharesToBuy * askPrice;
                retry = 0;
                console.log('Successfully posted order:', resp);
                await sleep(API_COOLDOWN);
            } else {
                retry++;
                const delay = API_COOLDOWN + retry * RETRY_BACKOFF;
                console.log(`Order failed. Retry ${retry}. Cooling ${delay}ms`);
                await sleep(delay);
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    // ================= SELL =================
    else if (condition === 'sell') {
        console.log('Sell Strategy...');
        if (!my_position || my_position.asset !== trade.asset) {
            console.log('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        const userPrevSize = (user_position?.size || 0) + trade.size;
        const reductionPct = userPrevSize > 0 ? trade.size / userPrevSize : 1;

        let remaining = my_position.size * reductionPct;
        let retry = 0;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook || !orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const bidPrice = Math.max(0, parseFloat(bestBid.price) - PRICE_NUDGE);
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: bidPrice,
                feeRateBps: feeRateBps
            };

            console.log('Order args:', order_args);

            await rateLimit();
            const signedOrder = await clobClient.createMarketOrder(order_args);

            await rateLimit();
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
                console.log('Successfully posted order:', resp);
                await sleep(API_COOLDOWN);
            } else {
                retry++;
                const delay = API_COOLDOWN + retry * RETRY_BACKOFF;
                console.log(`Order failed. Retry ${retry}. Cooling ${delay}ms`);
                await sleep(delay);
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } else {
        console.log('Condition not supported');
    }
};

export default postOrder;
