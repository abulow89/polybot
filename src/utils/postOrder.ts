import { ClobClient, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);

// ======== COOLDOWN HELPERS ========
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const ORDERBOOK_DELAY = 350;
const ORDER_POST_DELAY = 600;
const RETRY_DELAY = 1200;
// ==================================

const MIN_TAKER_AMOUNT = 0.01;
const MAX_MAKER_DECIMALS = 4;
const MAX_TAKER_DECIMALS = 2;

const bumpDust = (maker: number, price: number) => {
    let taker = parseFloat((maker * price).toFixed(MAX_TAKER_DECIMALS));
    if (taker < MIN_TAKER_AMOUNT) {
        maker = parseFloat((MIN_TAKER_AMOUNT / price).toFixed(MAX_MAKER_DECIMALS));
        taker = parseFloat((maker * price).toFixed(MAX_TAKER_DECIMALS));
    }
    return { maker, taker };
}

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {
    const processOrder = async (side: Side, asset: string, size: number, price: number, orderBook: any) => {
        let { maker, taker } = bumpDust(size, price);
        if (taker < MIN_TAKER_AMOUNT) {
            console.log('Order below dust threshold after bump, skipping...');
            return false;
        }
        const order_args = {
            side,
            tokenID: asset,
            amount: maker,
            price: parseFloat(price.toFixed(MAX_TAKER_DECIMALS)),
            feeRateBps: orderBook?.takerFeeBps || 1000
        };
        console.log('Order args:', order_args, 'TakerAmount:', taker);

        const signedOrder = await clobClient.createMarketOrder(order_args);
        const resp = await clobClient.postOrder(signedOrder, 'IOC' as any);
        return resp;
    };

    let retry = 0;

    if (condition === 'merge') {
        console.log('Merging Strategy...');
        if (!my_position || my_position.asset !== trade.asset) {
            console.log('No matching position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let remaining = my_position.size;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            await sleep(ORDERBOOK_DELAY);
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) break;

            const maxPriceBid = orderBook.bids.reduce((max, cur) => parseFloat(cur.price) > parseFloat(max.price) ? cur : max, orderBook.bids[0]);
            const sizeToSell = Math.min(remaining, parseFloat(maxPriceBid.size));

            const resp = await processOrder(Side.SELL, my_position.asset, sizeToSell, parseFloat(maxPriceBid.price), orderBook);

            await sleep(ORDER_POST_DELAY);

            if (resp?.success) {
                remaining -= parseFloat(sizeToSell.toFixed(MAX_MAKER_DECIMALS));
                retry = 0;
                console.log('Successfully posted order:', resp);
            } else {
                retry++;
                console.log('Error posting order: retrying...', resp);
                await sleep(RETRY_DELAY);
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } 

    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(0.01, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            await sleep(ORDERBOOK_DELAY);
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks || orderBook.asks.length === 0) break;

            const minPriceAsk = orderBook.asks.reduce((min, cur) => parseFloat(cur.price) < parseFloat(min.price) ? cur : min, orderBook.asks[0]);
            const askPrice = parseFloat(minPriceAsk.price);
            let affordableShares = remainingUSDC / askPrice;
            let makerAmount = Math.min(affordableShares, parseFloat(minPriceAsk.size));

            const { maker, taker } = bumpDust(makerAmount, askPrice);
            if (taker < MIN_TAKER_AMOUNT || Math.abs(askPrice - trade.price) > 0.05) {
                console.log('Order below dust threshold or price too far, skipping...');
                break;
            }

            const resp = await processOrder(Side.BUY, trade.asset, maker, askPrice, orderBook);
            await sleep(ORDER_POST_DELAY);

            if (resp?.success) {
                remainingUSDC -= taker;
                retry = 0;
                console.log('Successfully posted order:', resp);
            } else {
                retry++;
                console.log('Error posting order: retrying...', resp);
                await sleep(RETRY_DELAY);
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } 

    else if (condition === 'sell') {
        console.log('Sell Strategy...');
        if (!my_position) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;
        if (user_position) remaining *= trade.size / (user_position.size + trade.size);

        while (remaining > 0 && retry < RETRY_LIMIT) {
            await sleep(ORDERBOOK_DELAY);
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) break;

            const maxPriceBid = orderBook.bids.reduce((max, cur) => parseFloat(cur.price) > parseFloat(max.price) ? cur : max, orderBook.bids[0]);
            const sizeToSell = Math.min(remaining, parseFloat(maxPriceBid.size));

            const resp = await processOrder(Side.SELL, trade.asset, sizeToSell, parseFloat(maxPriceBid.price), orderBook);
            await sleep(ORDER_POST_DELAY);

            if (resp?.success) {
                remaining -= parseFloat(sizeToSell.toFixed(MAX_MAKER_DECIMALS));
                retry = 0;
                console.log('Successfully posted order:', resp);
            } else {
                retry++;
                console.log('Error posting order: retrying...', resp);
                await sleep(RETRY_DELAY);
            }
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } 

    else {
        console.log('Condition not supported');
    }
};

export default postOrder;
