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

            if (!orderBook.bids?.length) {
                console.log('No bids found');
                skippedOrders.push('No bids found');
                break;
            }

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );
            console.log('Best bid:', bestBid);

            const bidPrice = Math.max(0, parseFloat(bestBid.price) - PRICE_NUDGE);
            const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));
            
            if (sizeToSell < MIN_SHARES) break;

            const order_args = {
                side: Side.SELL,
                tokenID: my_position!.asset,
                amount: sizeToSell,
                price: bidPrice,
            };
            console.log('Order args (MERGE):', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            recordOrder(order_args, resp);

            if (resp.success) {
                console.log('Successfully posted MERGE order:', resp);
                remaining -= sizeToSell;
                retry = 0;
            } else {
                console.log('Error posting MERGE order, retrying...', resp);
                retry++;
            }
        }
    }

    // ================= BUY =================
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) break;

            if (!orderBook.asks?.length) {
                console.log('No asks found');
                skippedOrders.push('No asks found');
                break;
            }

            const bestAsk = orderBook.asks.reduce((a, b) =>
                parseFloat(b.price) < parseFloat(a.price) ? b : a
            );
            console.log('Best ask:', bestAsk);

            const rawAsk = parseFloat(bestAsk.price);
            if (Math.abs(rawAsk - trade.price) > MAX_SLIPPAGE) {
                console.log('Ask price too far from target — skipping');
                skippedOrders.push(`Ask price ${rawAsk} too far from ${trade.price}`);
                break;
            }

            const askPrice = rawAsk + PRICE_NUDGE;
            const maxSharesAtLevel = parseFloat(bestAsk.size);
            const affordableShares = remainingUSDC / askPrice;
            const sharesToBuy = Math.max(MIN_SHARES, Math.min(maxSharesAtLevel, affordableShares));
const marketInfo = await clobClient.getMarket(trade.asset);
const takerFeeBps = marketInfo?.takerFeeBps || 1000;

            
            const order_args = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: sharesToBuy,
                price: askPrice,
                takerFee: takerFeeBps
            };
            console.log('Order args (BUY):', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            recordOrder(order_args, resp);

            if (resp.success) {
                console.log(`Successfully posted BUY order: ${sharesToBuy} shares at ${askPrice}`, resp);
                remainingUSDC -= sharesToBuy * askPrice;
                retry = 0;
            } else {
                console.log('Error posting BUY order, retrying...', resp);
                retry++;
            }
        }
    }

    // ================= SELL =================
    else if (condition === 'sell') {
        console.log('Sell Strategy...');
        if (!my_position || my_position.asset !== trade.asset) {
            console.log('No position to sell');
            skippedOrders.push('No position to sell');
        }

        const userPrevSize = (user_position?.size || 0) + trade.size;
        const reductionPct = userPrevSize > 0 ? trade.size / userPrevSize : 1;
        let remaining = (my_position?.size || 0) * reductionPct;

        while (remaining >= MIN_SHARES && retry < RETRY_LIMIT) {
            const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
            if (!orderBook) break;

            if (!orderBook.bids?.length) {
                console.log('No bids found');
                skippedOrders.push('No bids found');
                break;
            }

            const bestBid = orderBook.bids.reduce((a, b) =>
                parseFloat(b.price) > parseFloat(a.price) ? b : a
            );
            console.log('Best bid:', bestBid);

            const bidPrice = Math.max(0, parseFloat(bestBid.price) - PRICE_NUDGE);
            const sizeToSell = Math.max(MIN_SHARES, Math.min(remaining, parseFloat(bestBid.size)));

            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: bidPrice,
            };
            console.log('Order args (SELL):', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            recordOrder(order_args, resp);

            if (resp.success) {
                console.log(`Successfully posted SELL order: ${sizeToSell} shares at ${bidPrice}`, resp);
                remaining -= sizeToSell;
                retry = 0;
            } else {
                console.log('Error posting SELL order, retrying...', resp);
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
