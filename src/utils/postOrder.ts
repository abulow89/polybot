import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const MAX_SLIPPAGE = 0.05;
const PRICE_NUDGE = 0.001; // makes FOK behave more like IOC

const UserActivity = getUserActivityModel(USER_ADDRESS);

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
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const rawBid = parseFloat(bestBid.price);
            if (rawBid < trade.price - MAX_SLIPPAGE) break;

            const bidPrice = Math.max(0, rawBid - PRICE_NUDGE); // 🔻 nudge down for priority
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

            const order_args = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount: sizeToSell,
                price: bidPrice,
            };

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
            } else retry++;
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
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks?.length) break;

            const bestAsk = orderBook.asks.reduce((a, b) =>
                parseFloat(b.price) < parseFloat(a.price) ? b : a
            );

            const rawAsk = parseFloat(bestAsk.price);
            if (Math.abs(rawAsk - trade.price) > MAX_SLIPPAGE) break;

            const askPrice = rawAsk + PRICE_NUDGE; // 🔺 nudge up for priority

            const maxSharesAtLevel = parseFloat(bestAsk.size);
            const affordableShares = remainingUSDC / askPrice;
            const sharesToBuy = Math.min(maxSharesAtLevel, affordableShares);

            if (sharesToBuy <= 0) break;

            const order_args = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: sharesToBuy,
                price: askPrice,
            };

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remainingUSDC -= sharesToBuy * askPrice;
                retry = 0;
            } else retry++;
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
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const rawBid = parseFloat(bestBid.price);
            if (rawBid < trade.price - MAX_SLIPPAGE) break;

            const bidPrice = Math.max(0, rawBid - PRICE_NUDGE);
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: bidPrice,
            };

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
            } else retry++;
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    else {
        console.log('Condition not supported');
    }
};

export default postOrder;
