import { ClobClient, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);

// ======== COOLDOWN HELPERS ========
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const ORDERBOOK_DELAY = 350;   // delay before fetching book
const ORDER_POST_DELAY = 600;  // delay after posting order
const RETRY_DELAY = 1200;      // delay when retrying
// ==================================

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
            await sleep(ORDERBOOK_DELAY);
            const orderBook = await clobClient.getOrderBook(trade.asset);

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('No bids found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, current) =>
                parseFloat(current.price) > parseFloat(max.price) ? current : max
            , orderBook.bids[0]);

            console.log('Max price bid:', maxPriceBid);

            const sizeToSell = Math.min(remaining, parseFloat(maxPriceBid.size));
            const makerAmount = parseFloat(sizeToSell.toFixed(4));
            const takerAmount = parseFloat((makerAmount * parseFloat(maxPriceBid.price)).toFixed(2));

            if (takerAmount < 0.01) {
                console.log('Order below dust threshold, skipping...');
                break;
            }

            const order_args = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount: makerAmount,
                price: parseFloat(maxPriceBid.price),
                feeRateBps: (orderBook as any).takerFeeBps || 1000
            };

            console.log('Order args:', order_args, 'TakerAmount:', takerAmount);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, 'IOC' as any);

            await sleep(ORDER_POST_DELAY);

            if (resp.success) {
                console.log('Successfully posted order:', resp);
                remaining -= makerAmount;
                retry = 0;
            } else {
                console.log('Error posting order: retrying...', resp);
                retry++;
                await sleep(RETRY_DELAY);
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    // ================= BUY =================
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(0.01, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);
        let retry = 0;

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            await sleep(ORDERBOOK_DELAY);
            const orderBook = await clobClient.getOrderBook(trade.asset);

            if (!orderBook.asks || orderBook.asks.length === 0) {
                console.log('No asks found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min, current) =>
                parseFloat(current.price) < parseFloat(min.price) ? current : min
            , orderBook.asks[0]);

            console.log('Min price ask:', minPriceAsk);

            const askPrice = parseFloat(minPriceAsk.price);
            let affordableShares = remainingUSDC / askPrice;

            // Maker/Taker rounding for API
            const makerAmount = parseFloat(Math.max(0.01, Math.min(affordableShares, parseFloat(minPriceAsk.size))).toFixed(4));
            const takerAmount = parseFloat((makerAmount * askPrice).toFixed(2));

            if (takerAmount < 0.01) {
                console.log('Order below dust threshold, skipping...');
                break;
            }

            if (Math.abs(askPrice - trade.price) > 0.05) {
                console.log('Ask price too far from target — skipping');
                break;
            }
const priceRounded = parseFloat(askPrice.toFixed(2));
            const order_args = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: makerAmount,
                takerAmount: takerAmount,
                price: roundedPrice,
                feeRateBps: (orderBook as any).takerFeeBps || 1000
            };

            console.log('Order args:', order_args, 'TakerAmount:', takerAmount);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, 'IOC' as any);

            await sleep(ORDER_POST_DELAY);

            if (resp.success) {
                console.log('Successfully posted order:', resp);
                remainingUSDC -= takerAmount;
                retry = 0;
            } else {
                console.log('Error posting order: retrying...', resp);
                retry++;
                await sleep(RETRY_DELAY);
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    // ================= SELL =================
    else if (condition === 'sell') {
        console.log('Sell Strategy...');
        if (!my_position) {
            console.log('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let remaining = my_position.size;
        if (user_position) {
            const ratio = trade.size / (user_position.size + trade.size);
            remaining *= ratio;
        }

        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            await sleep(ORDERBOOK_DELAY);
            const orderBook = await clobClient.getOrderBook(trade.asset);

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('No bids found');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, current) =>
                parseFloat(current.price) > parseFloat(max.price) ? current : max
            , orderBook.bids[0]);

            const makerAmount = parseFloat(Math.min(remaining, parseFloat(maxPriceBid.size)).toFixed(4));
            const takerAmount = parseFloat((makerAmount * parseFloat(maxPriceBid.price)).toFixed(2));

            if (takerAmount < 0.01) {
                console.log('Order below dust threshold, skipping...');
                break;
            }

            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: makerAmount,
                price: parseFloat(maxPriceBid.price),
                feeRateBps: (orderBook as any).takerFeeBps || 1000
            };

            console.log('Order args:', order_args, 'TakerAmount:', takerAmount);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, 'IOC' as any);

            await sleep(ORDER_POST_DELAY);

            if (resp.success) {
                console.log('Successfully posted order:', resp);
                remaining -= makerAmount;
                retry = 0;
            } else {
                console.log('Error posting order: retrying...', resp);
                retry++;
                await sleep(RETRY_DELAY);
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } else {
        console.log('Condition not supported');
    }
};

export default postOrder;
