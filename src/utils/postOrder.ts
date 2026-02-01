import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
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
    let remaining: number;
    let retry = 0;

    if (condition === 'merge') {
        console.log('Merging Strategy...');
        if (!my_position || my_position.asset !== trade.asset) {
            console.log('No matching position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        remaining = my_position.size;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids?.length) break;

            const maxPriceBid = orderBook.bids.reduce((max, bid) =>
                parseFloat(bid.price) > parseFloat(max.price) ? bid : max
            );

            const sizeToSell = Math.max(1, Math.min(remaining, parseFloat(maxPriceBid.size)));
            const order_args = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount: sizeToSell,
                price: parseFloat(maxPriceBid.price),
            };

            console.log('Max price bid:', maxPriceBid);
            console.log('Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
                console.log('Successfully posted order:', resp);
            } else {
                retry++;
                console.log('Error posting order, retrying...', resp);
            }
        }
    } 
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        remaining = Math.min(trade.usdcSize * ratio, my_balance);

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks?.length) break;

            const minPriceAsk = orderBook.asks.reduce((min, ask) =>
                parseFloat(ask.price) < parseFloat(min.price) ? ask : min
            );

            const askPrice = parseFloat(minPriceAsk.price);
            const affordableShares = remaining / askPrice;
            const sharesToBuy = Math.max(1, Math.min(affordableShares, parseFloat(minPriceAsk.size)));

            if (sharesToBuy * askPrice > remaining) break; // not enough funds for 1 share

            const order_args = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: sharesToBuy,
                price: askPrice,
            };

            console.log('ratio', ratio);
            console.log('Min price ask:', minPriceAsk);
            console.log('Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sharesToBuy * askPrice;
                retry = 0;
                console.log('Successfully posted order:', resp);
            } else {
                retry++;
                console.log('Error posting order, retrying...', resp);
            }
        }
    } 
    else if (condition === 'sell') {
        console.log('Sell Strategy...');
        if (!my_position || my_position.asset !== trade.asset) {
            console.log('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        const userPrevSize = (user_position?.size || 0) + trade.size;
        const reductionPct = userPrevSize > 0 ? trade.size / userPrevSize : 1;
        remaining = Math.max(1, my_position.size * reductionPct);

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids?.length) break;

            const maxPriceBid = orderBook.bids.reduce((max, bid) =>
                parseFloat(b.price) > parseFloat(max.price) ? b : max
            );

            const sizeToSell = Math.max(1, Math.min(remaining, parseFloat(maxPriceBid.size)));
            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: parseFloat(maxPriceBid.price),
            };

            console.log('Max price bid:', maxPriceBid);
            console.log('Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                remaining -= sizeToSell;
                retry = 0;
                console.log('Successfully posted order:', resp);
            } else {
                retry++;
                console.log('Error posting order, retrying...', resp);
            }
        }
    } 
    else {
        console.log('Condition not supported');
    }

    // Mark trade as executed in any case
    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
};

export default postOrder;
