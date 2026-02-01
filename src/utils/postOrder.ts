import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const MAX_SLIPPAGE = 0.05;
const PRICE_NUDGE = 0.001;
const MIN_SHARES = 1;

const UserActivity = getUserActivityModel(USER_ADDRESS);

//
// ===== API STABILITY + MONITOR LAYER =====
//
let dynamicDelay = 200;
const MAX_DELAY = 3000;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const withTimeout = async <T>(promise: Promise<T>, ms = 5000): Promise<T> =>
    Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error('API timeout')), ms)
        )
    ]);

const handleApiIssue = (reason: string) => {
    dynamicDelay = Math.min(dynamicDelay * 1.5, MAX_DELAY);
    console.log(`⚠️ API issue (${reason}) → slowing to ${Math.floor(dynamicDelay)}ms`);
};

const handleApiSuccess = () => {
    if (dynamicDelay > 200) {
        dynamicDelay = Math.max(200, dynamicDelay * 0.9);
        console.log(`✅ API stable → speeding to ${Math.floor(dynamicDelay)}ms`);
    }
};

//
// ===== SAFE ORDERBOOK FETCH =====
//
const getOrderBookSafe = async (
    clobClient: ClobClient,
    tokenID: string,
    tradeId: string
) => {
    try {
        await sleep(dynamicDelay);
        console.log(`📡 Fetching orderbook ${tokenID} (delay ${dynamicDelay}ms)`);

        const ob = await withTimeout(clobClient.getOrderBook(tokenID));

        if (!ob?.bids && !ob?.asks) {
            console.log(`⚠️ Orderbook empty/undefined for ${tokenID}`);
        }

        handleApiSuccess();
        return ob;

    } catch (err: any) {
        handleApiIssue(err.message);

        if (err?.response?.status === 404) {
            console.log('🚫 Market not found — marking trade complete');
            await UserActivity.updateOne({ _id: tradeId }, { bot: true });
            return null;
        }

        console.log(`❌ OrderBook error:`, err.message);
        throw err;
    }
};

//
// ===== MAIN ORDER FUNCTION =====
//
const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {

    console.log(`💓 Bot active | Delay=${dynamicDelay}ms | ${new Date().toLocaleTimeString()}`);
    console.log(`🧾 Trade ${trade._id} | ${condition} | Asset=${trade.asset}`);

    if (!trade.asset) console.log('⚠️ Trade asset undefined');
    if (!trade.price) console.log('⚠️ Trade price undefined');
    if (!trade.usdcSize && condition === 'buy') console.log('⚠️ Trade usdcSize undefined');

    // ================= MERGE =================
    if (condition === 'merge') {
        if (!my_position || my_position.asset !== trade.asset) {
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

            const signedOrder = await clobClient.createMarketOrder({
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: bidPrice
            });

            await sleep(dynamicDelay);
            const resp = await withTimeout(clobClient.postOrder(signedOrder, OrderType.FOK))
                .catch(e => { handleApiIssue(e.message); throw e; });

            handleApiSuccess();

            if (resp.success) remaining -= sizeToSell;
            else retry++;
        }
    }

    // ================= BUY =================
    else if (condition === 'buy') {
        let remainingUSDC = Math.min(trade.usdcSize, my_balance);
        let retry = 0;

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook || !orderBook.asks?.length) break;

            const bestAsk = orderBook.asks.reduce((a, b) =>
                parseFloat(b.price) < parseFloat(a.price) ? b : a
            );

            const askPrice = parseFloat(bestAsk.price) + PRICE_NUDGE;
            const sharesToBuy = Math.max(
                MIN_SHARES,
                Math.min(parseFloat(bestAsk.size), remainingUSDC / askPrice)
            );

            const signedOrder = await clobClient.createMarketOrder({
                side: Side.BUY,
                tokenID: trade.asset,
                amount: sharesToBuy,
                price: askPrice
            });

            await sleep(dynamicDelay);
            const resp = await withTimeout(clobClient.postOrder(signedOrder, OrderType.FOK))
                .catch(e => { handleApiIssue(e.message); throw e; });

            handleApiSuccess();

            if (resp.success) remainingUSDC -= sharesToBuy * askPrice;
            else retry++;
        }
    }

    // ================= SELL =================
    else if (condition === 'sell') {
        if (!my_position || my_position.asset !== trade.asset) {
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

            const signedOrder = await clobClient.createMarketOrder({
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: bidPrice
            });

            await sleep(dynamicDelay);
            const resp = await withTimeout(clobClient.postOrder(signedOrder, OrderType.FOK))
                .catch(e => { handleApiIssue(e.message); throw e; });

            handleApiSuccess();

            if (resp.success) remaining -= sizeToSell;
            else retry++;
        }
    }

    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
};

export default postOrder;
