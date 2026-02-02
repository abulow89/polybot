import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const MIN_SHARES = 1;
const PRICE_NUDGE = 0.001;
const MAX_SLIPPAGE = 0.05;

const UserActivity = getUserActivityModel(USER_ADDRESS);

// Helper: round numbers
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
    // Fetch dynamic fee
    const marketInfo = await clobClient.getMarket(trade.asset);
    const feeRateBps = marketInfo?.feeRateBps ?? 1000;
    console.log('Market feeRateBps:', feeRateBps);

    // ======== MERGE STRATEGY ========
    if (condition === 'merge') {
        console.log('Merging Strategy...');
        if (!my_position) {
            console.log('my_position is undefined');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = round(my_position.size, 4);
        let retry = 0;

        while (remaining >= MIN_SHARES && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook?.bids?.length) {
                console.log('No bids found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) =>
                parseFloat(bid.price) > parseFloat(max.price) ? bid : max
            , orderBook.bids[0]);
            console.log('Max price bid:', maxPriceBid);

            const sizeToSell = round(Math.min(remaining, parseFloat(maxPriceBid.size)), 4);
            const price = round(parseFloat(maxPriceBid.price), 2);

            const order_args = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount: sizeToSell,
                price,
                takerFee: feeRateBps
            };
            console.log('Order args (MERGE):', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                console.log('Successfully posted MERGE order:', resp);
                remaining -= sizeToSell;
                retry = 0;
            } else {
                console.log('Error posting MERGE order: retrying...', resp);
                retry++;
            }
        }
    }

    // ======== BUY STRATEGY ========
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = round(Math.min(trade.usdcSize * ratio, my_balance), 2);
        let retry = 0;

        while (remainingUSDC >= 0.01 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook?.asks?.length) {
                console.log('No asks found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min, ask) =>
                parseFloat(ask.price) < parseFloat(min.price) ? ask : min
            , orderBook.asks[0]);
            console.log('Min price ask:', minPriceAsk);

            const askPrice = round(parseFloat(minPriceAsk.price) + PRICE_NUDGE, 2);
            if (Math.abs(askPrice - trade.price) > MAX_SLIPPAGE) {
                console.log('Ask price too far from target — skipping');
                break;
            }

            const maxSharesAtLevel = parseFloat(minPriceAsk.size);
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

            if (resp.success) {
                console.log('Successfully posted BUY order:', resp);
                remainingUSDC -= round(sharesToBuy * askPrice, 2);
                retry = 0;
            } else {
                console.log('Error posting BUY order: retrying...', resp);
                retry++;
            }
        }
    }

    // ======== SELL STRATEGY ========
    else if (condition === 'sell') {
        console.log('Sell Strategy...');
        let remaining = my_position ? round(my_position.size, 4) : 0;

        if (my_position && user_position) {
            const ratio = trade.size / (user_position.size + trade.size);
            remaining = round(my_position.size * ratio, 4);
        }

        let retry = 0;
        while (remaining >= MIN_SHARES && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook?.bids?.length) {
                console.log('No bids found');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) =>
                parseFloat(bid.price) > parseFloat(max.price) ? bid : max
            , orderBook.bids[0]);
            console.log('Max price bid:', maxPriceBid);

            const sizeToSell = round(Math.min(remaining, parseFloat(maxPriceBid.size)), 4);
            const price = round(parseFloat(maxPriceBid.price), 2);

            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price,
                takerFee: feeRateBps
            };
            console.log('Order args (SELL):', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success) {
                console.log('Successfully posted SELL order:', resp);
                remaining -= sizeToSell;
                retry = 0;
            } else {
                console.log('Error posting SELL order: retrying...', resp);
                retry++;
            }
        }
    } else {
        console.log('Condition not supported');
    }

    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
};

export default postOrder;
