import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const MAX_SLIPPAGE = 0.05;
const PRICE_NUDGE = 0.001; // makes FOK behave more like IOC

const UserActivity = getUserActivityModel(USER_ADDRESS);

// helper: safe getOrderBook that treats 404 as terminal
const getOrderBookSafe = async (
    clobClient: ClobClient,
    tokenID: string,
    tradeId: string
) => {
    try {
        return await clobClient.getOrderBook(tokenID);
    } catch (err: any) {
        if (err?.response?.status === 404) {
            console.log('No CLOB market for token — skipping permanently');
            await UserActivity.updateOne({ _id: tradeId }, { bot: true });
            return null; // terminal
        }
        throw err; // rethrow other errors
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

    console.log('--------------------------------------------');
    console.log(`My Balance: ${my_balance}, Target User Balance: ${user_balance}`);
    console.log(`Processing ${condition.toUpperCase()} for token ${trade.asset}...`);
    console.log('--------------------------------------------');

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
            if (!orderBook) return; // 404 terminal
            if (!orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((max, bid) =>
                parseFloat(bid.price) > parseFloat(max.price) ? bid : max
            , orderBook.bids[0]);

            const rawBid = parseFloat(bestBid.price);
            if (rawBid < trade.price - MAX_SLIPPAGE) break;

            const bidPrice = Math.max(0, rawBid - PRICE_NUDGE);
            const sizeToSell = Math.max(1, Math.min(remaining, parseFloat(bestBid.size)));

            const order_args = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount: sizeToSell,
                price: bidPrice,
                feeRateBps: 1000
            };

            console.log('Merge Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            console.log('Merge order response:', resp);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
            } else {
                retry++;
                console.log(`Merge retry #${retry}`);
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    // ================= BUY =================
    else if (condition === 'buy') {
        console.log('Buy Strategy...');

        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);

        console.log(`Buy ratio: ${ratio}, Remaining USDC to spend: ${remainingUSDC}`);

        let retry = 0;

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) return; // 404 terminal
            if (!orderBook.asks?.length) break;

            const bestAsk = orderBook.asks.reduce((min, ask) =>
                parseFloat(ask.price) < parseFloat(min.price) ? ask : min
            , orderBook.asks[0]);

            const rawAsk = parseFloat(bestAsk.price);
            if (Math.abs(rawAsk - trade.price) > MAX_SLIPPAGE) {
                console.log('Ask price too far from target — skipping');
                break;
            }

            const askPrice = rawAsk + PRICE_NUDGE;
            const maxSharesAtLevel = parseFloat(bestAsk.size);
            const affordableShares = remainingUSDC / askPrice;
            const sharesToBuy = Math.max(1, Math.min(maxSharesAtLevel, affordableShares));

            if (sharesToBuy <= 0) break;

            const order_args = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: sharesToBuy,
                price: askPrice,
                feeRateBps: 1000
            };

            console.log('Buy Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            console.log('Buy order response:', resp);

            if (resp.success) {
                remainingUSDC -= sharesToBuy * askPrice;
                retry = 0;
            } else {
                retry++;
                console.log(`Buy retry #${retry}`);
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

        console.log(`Remaining shares to sell: ${remaining}`);

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) return; // 404 terminal
            if (!orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((max, bid) =>
                parseFloat(bid.price) > parseFloat(max.price) ? bid : max
            , orderBook.bids[0]);

            const rawBid = parseFloat(bestBid.price);
            if (rawBid < trade.price - MAX_SLIPPAGE) break;

            const bidPrice = Math.max(0, rawBid - PRICE_NUDGE);
            const sharesToSell = Math.max(1, Math.min(remaining, parseFloat(bestBid.size)));

            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sharesToSell,
                price: bidPrice,
                feeRateBps: 1000
            };

            console.log('Sell Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            console.log('Sell order response:', resp);

            if (resp.success) {
                remaining -= sharesToSell;
                retry = 0;
            } else {
                retry++;
                console.log(`Sell retry #${retry}`);
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    else {
        console.log('Condition not supported');
    }
};

export default postOrder;
