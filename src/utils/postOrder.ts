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

    let retry = 0;

    const logTradeStatus = (msg: string, extra?: any) => {
        console.log(`[${trade._id}] ${msg}`, extra ?? '');
    };

    // ================= MERGE =================
    if (condition === 'merge') {
        logTradeStatus('Merging Strategy...');

        if (!my_position || my_position.asset !== trade.asset) {
            logTradeStatus('No matching position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let remaining = my_position.size;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) return;
            if (!orderBook.bids?.length) {
                logTradeStatus('No bids found to merge');
                break;
            }

            const bestBid = orderBook.bids.reduce((a, b) => parseFloat(b.price) > parseFloat(a.price) ? b : a);
            const bidPrice = Math.max(0, parseFloat(bestBid.price) - PRICE_NUDGE);
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

            const order_args = { side: Side.SELL, tokenID: my_position.asset, amount: sizeToSell, price: bidPrice };
            logTradeStatus('Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
                logTradeStatus('Successfully posted order:', resp);
            } else {
                retry++;
                logTradeStatus('Error posting order, retrying...', resp);
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });

    }

    // ================= BUY =================
    else if (condition === 'buy') {
        logTradeStatus('Buy Strategy...');

        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        logTradeStatus('Balance ratio vs user:', ratio);

        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) return;
            if (!orderBook.asks?.length) {
                logTradeStatus('No asks found');
                break;
            }

            const bestAsk = orderBook.asks.reduce((a, b) => parseFloat(b.price) < parseFloat(a.price) ? b : a);
            const askPrice = parseFloat(bestAsk.price) + PRICE_NUDGE;

            if (Math.abs(askPrice - trade.price) > MAX_SLIPPAGE) {
                logTradeStatus('Price difference too high, skipping trade', { askPrice, tradePrice: trade.price });
                break;
            }

            const maxSharesAtLevel = parseFloat(bestAsk.size);
            const affordableShares = remainingUSDC / askPrice;
            const sharesToBuy = Math.min(maxSharesAtLevel, affordableShares);

            if (sharesToBuy <= 0) break;

            const order_args = { side: Side.BUY, tokenID: trade.asset, amount: sharesToBuy, price: askPrice };
            logTradeStatus('Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remainingUSDC -= sharesToBuy * askPrice;
                retry = 0;
                logTradeStatus('Successfully posted order:', resp);
            } else {
                retry++;
                logTradeStatus('Error posting order, retrying...', resp);
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
    }

    // ================= SELL =================
    else if (condition === 'sell') {
        logTradeStatus('Sell Strategy...');

        if (!my_position || my_position.asset !== trade.asset) {
            logTradeStatus('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        const userPrevSize = (user_position?.size || 0) + trade.size;
        const reductionPct = userPrevSize > 0 ? trade.size / userPrevSize : 1;

        let remaining = my_position.size * reductionPct;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) return;
            if (!orderBook.bids?.length) {
                logTradeStatus('No bids found');
                break;
            }

            const bestBid = orderBook.bids.reduce((a, b) => parseFloat(b.price) > parseFloat(a.price) ? b : a);
            const bidPrice = Math.max(0, parseFloat(bestBid.price) - PRICE_NUDGE);
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

            const order_args = { side: Side.SELL, tokenID: trade.asset, amount: sizeToSell, price: bidPrice };
            logTradeStatus('Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
                logTradeStatus('Successfully posted order:', resp);
            } else {
                retry++;
                logTradeStatus('Error posting order, retrying...', resp);
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
    }

    else {
        logTradeStatus('Condition not supported', condition);
    }
};

export default postOrder;
