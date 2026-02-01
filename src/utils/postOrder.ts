import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const MAX_SLIPPAGE = 0.05;
const PRICE_NUDGE = 0.001; // makes FOK behave more like IOC
const MIN_SHARES = 1; // enforce minimum 1 share

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

        while (remaining >= MIN_SHARES && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) return; // 404 terminal
            if (!orderBook.bids?.length) {
                console.log('No bids found in orderbook');
                break;
            }

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const rawBid = parseFloat(bestBid.price);
            if (rawBid < trade.price - MAX_SLIPPAGE) {
                console.log('Best bid below acceptable price — skipping');
                break;
            }

            const bidPrice = Math.max(0, rawBid - PRICE_NUDGE);
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

            if (sizeToSell < MIN_SHARES) break;

            const order_args = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount: sizeToSell,
                price: bidPrice,
            };

            console.log('Order args (MERGE):', order_args);
            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                console.log('Successfully posted MERGE order:', resp);
                remaining -= sizeToSell;
                retry = 0;
            } else {
                console.log('Error posting MERGE order, retrying...', resp);
                retry++;
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
    }

    // ================= BUY =================
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);
        let retry = 0;

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) return; // 404 terminal
            if (!orderBook.asks?.length) {
                console.log('No asks found in orderbook');
                break;
            }

            const bestAsk = orderBook.asks.reduce((a, b) =>
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
            const sharesToBuy = Math.min(maxSharesAtLevel, affordableShares);

            if (sharesToBuy < MIN_SHARES) break;

            const order_args = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: sharesToBuy,
                price: askPrice,
            };

            console.log('Order args (BUY):', order_args);
            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                console.log('Successfully posted BUY order:', resp);
                remainingUSDC -= sharesToBuy * askPrice;
                retry = 0;
            } else {
                console.log('Error posting BUY order, retrying...', resp);
                retry++;
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
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

        while (remaining >= MIN_SHARES && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) return; // 404 terminal
            if (!orderBook.bids?.length) {
                console.log('No bids found in orderbook');
                break;
            }

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const rawBid = parseFloat(bestBid.price);
            if (rawBid < trade.price - MAX_SLIPPAGE) {
                console.log('Bid price below acceptable price — skipping');
                break;
            }

            const bidPrice = Math.max(0, rawBid - PRICE_NUDGE);
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

            if (sizeToSell < MIN_SHARES) break;

            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: bidPrice,
            };

            console.log('Order args (SELL):', order_args);
            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                console.log('Successfully posted SELL order:', resp);
                remaining -= sizeToSell;
                retry = 0;
            } else {
                console.log('Error posting SELL order, retrying...', resp);
                retry++;
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
    } else {
        console.log('Condition not supported');
    }
};

export default postOrder;
