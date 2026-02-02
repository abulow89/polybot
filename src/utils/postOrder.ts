import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const MAX_SLIPPAGE = 0.05;
const PRICE_NUDGE = 0.001; // makes FOK behave more like IOC
const MIN_SHARES = 1;      // enforce minimum 1 share

const UserActivity = getUserActivityModel(USER_ADDRESS);

// ================= TIMING HELPERS =================
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 350; // ms between ANY exchange call

const throttle = async () => {
    const now = Date.now();
    const diff = now - lastRequestTime;
    if (diff < MIN_REQUEST_INTERVAL) {
        await sleep(MIN_REQUEST_INTERVAL - diff);
    }
    lastRequestTime = Date.now();
};

// ================= SAFE REQUEST =================
const safeRequest = async <T>(fn: () => Promise<T>, retry = 0): Promise<T> => {
    try {
        await throttle();
        return await fn();
    } catch (err: unknown) {
        const e = err as any;
        const status = e?.response?.status;

        if (status === 429) {
            const backoff = Math.min(2000 * Math.pow(2, retry) + Math.random() * 500, 10000);
            console.log(`[CLOB] Rate limited (429). Cooling off ${Math.round(backoff)}ms`);
            await sleep(backoff);
            return safeRequest(fn, retry + 1);
        }

        if (status >= 500) {
            const backoff = 1000 + Math.random() * 1000;
            console.log(`[CLOB] Server error ${status}. Retry in ${Math.round(backoff)}ms`);
            await sleep(backoff);
            return safeRequest(fn, retry + 1);
        }

        const msg = e?.response?.data?.error || e?.message || e;
        console.log(`[CLOB] Request error:`, msg);

        throw err;
    }
};

// ================= LOOP BACKOFF =================
const loopBackoff = async (retry: number) => {
    if (retry <= 0) return;
    const delay = Math.min(300 * Math.pow(2, retry) + Math.random() * 200, 5000);
    console.log(`Retry ${retry}, backing off ${Math.round(delay)}ms`);
    await sleep(delay);
};

// ================= MARKET HELPERS =================
const getOrderBookSafe = async (
    clobClient: ClobClient,
    tokenID: string,
    tradeId: string
) => {
    try {
        return await safeRequest(() => clobClient.getOrderBook(tokenID));
    } catch (err: unknown) {
        const e = err as any;
        if (e?.response?.status === 404) {
            console.log('No CLOB market for token — skipping permanently');
            await UserActivity.updateOne({ _id: tradeId }, { bot: true });
            return null;
        }
        throw err;
    }
};

const getMarketTakerFeeBps = async (clobClient: ClobClient, tokenID: string) => {
    try {
        const marketInfo = await safeRequest(() => clobClient.getMarket(tokenID));
        return marketInfo?.takerFeeBps || 0;
    } catch {
        console.log('Error fetching market taker fee — defaulting to 0');
        return 0;
    }
};

// ================= POST ORDER =================
const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {

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
            if (!orderBook) return;
            if (!orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const rawBid = parseFloat(bestBid.price);
            if (rawBid < trade.price - MAX_SLIPPAGE) break;

            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));
            const bidPrice = Math.max(0, rawBid - PRICE_NUDGE);

            const signedOrder = await safeRequest(() =>
                clobClient.createMarketOrder({
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: sizeToSell,
                    price: bidPrice,
                })
            );

            const resp = await safeRequest(() =>
                clobClient.postOrder(signedOrder, OrderType.FOK)
            );

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
            } else {
                retry++;
                await loopBackoff(retry);
            }

            await sleep(200 + Math.random() * 300);
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
            if (!orderBook) return;
            if (!orderBook.asks?.length) break;

            const bestAsk = orderBook.asks.reduce((a, b) =>
                parseFloat(b.price) < parseFloat(a.price) ? b : a
            );

            const rawAsk = parseFloat(bestAsk.price);
            if (Math.abs(rawAsk - trade.price) > MAX_SLIPPAGE) break;

            const askPrice = rawAsk + PRICE_NUDGE;
            const maxShares = parseFloat(bestAsk.size);
            const affordable = remainingUSDC / askPrice;
            const sharesToBuy = Math.max(MIN_SHARES, Math.min(maxShares, affordable));

            if (sharesToBuy <= 0) break;

            const feeRateBps = await getMarketTakerFeeBps(clobClient, trade.asset);

            const signedOrder = await safeRequest(() =>
                clobClient.createMarketOrder({
                    side: Side.BUY,
                    tokenID: trade.asset,
                    amount: sharesToBuy,
                    price: askPrice,
                    feeRateBps,
                })
            );

            const resp = await safeRequest(() =>
                clobClient.postOrder(signedOrder, OrderType.FOK)
            );

            if (resp.success) {
                remainingUSDC -= sharesToBuy * askPrice;
                retry = 0;
            } else {
                retry++;
                await loopBackoff(retry);
            }

            await sleep(200 + Math.random() * 300);
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
            if (!orderBook) return;
            if (!orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const rawBid = parseFloat(bestBid.price);
            if (rawBid < trade.price - MAX_SLIPPAGE) break;

            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));
            const bidPrice = Math.max(0, rawBid - PRICE_NUDGE);
            const feeRateBps = await getMarketTakerFeeBps(clobClient, trade.asset);

            const signedOrder = await safeRequest(() =>
                clobClient.createMarketOrder({
                    side: Side.SELL,
                    tokenID: trade.asset,
                    amount: sizeToSell,
                    price: bidPrice,
                    feeRateBps,
                })
            );

            const resp = await safeRequest(() =>
                clobClient.postOrder(signedOrder, OrderType.FOK)
            );

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
            } else {
                retry++;
                await loopBackoff(retry);
            }

            await sleep(200 + Math.random() * 300);
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    else {
        console.log('Condition not supported');
    }
};

export default postOrder;
