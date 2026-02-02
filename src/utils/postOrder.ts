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
            return null;
        }
        throw err;
    }
};

// Helper: round number to decimals
const round = (value: number, decimals: number) => parseFloat(value.toFixed(decimals));

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
    let executedOrders: any[] = [];
    let skippedOrders: string[] = [];

    const recordOrder = (order: any, resp: any) => {
        if (resp.success) executedOrders.push(order);
        else skippedOrders.push(order);
    };

    // ================= FETCH MARKET INFO FOR FEES =================
    const marketInfo = await clobClient.getMarket(trade.asset);
    const feeRateBps = marketInfo?.feeRateBps ?? 1000; // dynamic fee with fallback
    console.log('Market feeRateBps:', feeRateBps);

    // ================= MERGE =================
    if (condition === 'merge') {
        console.log('Merging Strategy...');
        if (!my_position || my_position.asset !== trade.asset) {
            console.log('No matching position to merge');
            skippedOrders.push('No matching position');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }

        let remaining = my_position?.size || 0;

        while (remaining >= MIN_SHARES && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) break;
            if (!orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const bidPrice = round(Math.max(0, parseFloat(bestBid.price) - PRICE_NUDGE), 2);
            const sizeToSell = round(Math.min(remaining, parseFloat(bestBid.size)), 4);
            
            if (sizeToSell < MIN_SHARES) break;

            const order_args = {
                side: Side.SELL,
                tokenID: my_position!.asset,
                amount: sizeToSell,
                price: bidPrice,
                takerFee: feeRateBps
            };
            console.log('Order args (MERGE):', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            recordOrder(order_args, resp);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
            } else {
                retry++;
            }
        }
    }

    // ================= BUY =================
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = round(Math.min(trade.usdcSize * ratio, my_balance), 2);

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook || !orderBook.asks?.length) break;

            const bestAsk = orderBook.asks.reduce((a, b) =>
                parseFloat(b.price) < parseFloat(a.price) ? b : a
            );

            const rawAsk = parseFloat(bestAsk.price);
            if (Math.abs(rawAsk - trade.price) > MAX_SLIPPAGE) break;

            const askPrice = round(rawAsk + PRICE_NUDGE, 2);
            const maxSharesAtLevel = parseFloat(bestAsk.size);
            const affordableShares = remainingUSDC / askPrice;
            const sharesToBuy = round(Math.max(MIN_SHARES, Math.min(maxSharesAtLevel, affordableShares)), 4);

            const order_args = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: sharesToBuy,
                price: askPrice,
                takerFee: feeRateBps
            };
            console.log('Order args (BUY):', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            recordOrder(order_args, resp);

            if (resp.success) {
                remainingUSDC -= round(sharesToBuy * askPrice, 2);
                retry = 0;
            } else {
                retry++;
            }
        }
    }

    // ================= SELL =================
    else if (condition === 'sell') {
        console.log('Sell Strategy...');
        if (!my_position || my_position.asset !== trade.asset) return;

        const userPrevSize = (user_position?.size || 0) + trade.size;
        const reductionPct = userPrevSize > 0 ? trade.size / userPrevSize : 1;
        let remaining = round((my_position?.size || 0) * reductionPct, 4);

        while (remaining >= MIN_SHARES && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook || !orderBook.bids?.length) break;

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );

            const bidPrice = round(Math.max(0, parseFloat(bestBid.price) - PRICE_NUDGE), 2);
            const sizeToSell = round(Math.max(MIN_SHARES, Math.min(remaining, parseFloat(bestBid.size))), 4);

            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: bidPrice,
                takerFee: feeRateBps
            };
            console.log('Order args (SELL):', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            recordOrder(order_args, resp);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
            } else {
                retry++;
            }
        }
    }

    // ================= SUMMARY =================
    console.log('▰▰▰▰▰▰▰ Order Summary ▰▰▰▰▰▰▰');
    console.log('Executed Orders:', executedOrders.length ? executedOrders : 'None');
    console.log('Skipped Orders:', skippedOrders.length ? skippedOrders : 'None');
    console.log('Total retries:', retry);
    console.log('▰▰▰▰▰▰▰ End of Summary ▰▰▰▰▰▰▰');

    await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
};

export default postOrder;
