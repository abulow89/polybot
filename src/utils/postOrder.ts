import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);


// Helper: get current UTC timestamp
const getUtcTimestamp = () => Math.floor(Date.now() / 1000);
// ======== COOLDOWN HELPERS ========
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const ORDERBOOK_DELAY = 350;   // delay before fetching book
const ORDER_POST_DELAY = 600;  // delay after posting order
const RETRY_DELAY = 1200;      // delay when retrying
// ==================================
const safePostOrder = async (
  clobClient: ClobClient,
  signedOrder: any,
  orderType: OrderType,
  maxRetries = 3
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const localTs = getUtcTimestamp();
    console.log(`[Timestamp Check] Attempt ${attempt}: local UTC timestamp = ${localTs}`);

    try {
      const resp = await clobClient.postOrder(signedOrder, orderType);
      console.log('[CLOB] Order posted successfully:', resp);
      return resp;
    } catch (err: any) {
      if (err?.data?.error === 'market not found' || err?.status === 404) {
        console.warn(`[CLOB] Possible timestamp mismatch or market unavailable. Attempt ${attempt} failed.`);
      } else {
        console.error('[CLOB] Unexpected error posting order:', err);
      }

      if (attempt < maxRetries) {
        console.log(`Retrying after 1s...`);
        await sleep(1000);
      } else {
        console.error('[CLOB] Max retries reached. Order failed.');
        throw err;
      }
    }
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
    // ================= FETCH MARKET INFO FOR FEES =================
    let feeRateBps: number = 1000;

    try {
        const market = await clobClient.getMarket(trade.asset);
        if (!market) {
            console.warn(`[CLOB] Market not found for ${trade.asset}. Using 1000 fees.`);
        }
        feeRateBps = market?.makerFeeRateBps ?? market?.takerFeeRateBps ?? 1000;
    } catch (err: unknown) {
        if (process.env.DEBUG_FEES) {
            if (err instanceof Error) {
                console.warn(
                    `[CLOB] Could not fetch market fee for ${trade.asset}, using 1000`,
                    err.message
                );
            } else {
                console.warn(`[CLOB] Could not fetch market fee for ${trade.asset}, using 1000`, err);
            }
        }
    }

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

            const maxPriceBid = orderBook.bids.reduce(
                (max, current) => parseFloat(current.price) > parseFloat(max.price) ? current : max,
                orderBook.bids[0]
            );

            console.log('Max price bid:', maxPriceBid);

            const sizeToSell = Math.min(remaining, parseFloat(maxPriceBid.size));
            const order_args = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount: sizeToSell,
                price: parseFloat(maxPriceBid.price),
                feeRateBps: feeRateBps,
            };

            console.log('Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            await sleep(ORDER_POST_DELAY);

            if (resp.success) {
                console.log('Successfully posted order:', resp);
                remaining -= sizeToSell;
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

    const market = await ensureMarketExists(clobClient, trade.asset);
    if (!market) {
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, error: 'market_missing' });
        return;
    }

    const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
    let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);

    while (remainingUSDC > 0) {
        await sleep(ORDERBOOK_DELAY);

        const orderBook = await clobClient.getOrderBook(trade.asset);
        if (!orderBook.asks?.length) {
            console.log('No asks found');
            break;
        }

        const bestAsk = orderBook.asks.reduce((min, a) =>
            parseFloat(a.price) < parseFloat(min.price) ? a : min
        );

        const askPrice = parseFloat(bestAsk.price);

        // 🔍 PRICE GUARD (separate from market errors)
        if (Math.abs(askPrice - trade.price) > 0.05) {
            console.log('[PRICE SKIP] Ask too far from trade price');
            break;
        }

        const shares = Math.min(
            remainingUSDC / askPrice,
            parseFloat(bestAsk.size)
        );

        const orderArgs = {
            side: Side.BUY,
            tokenID: trade.asset,
            amount: shares,
            price: askPrice,
            feeRateBps: market.makerFeeRateBps ?? market.takerFeeRateBps ?? 1000,
        };

        console.log('[ORDER]', orderArgs);

        const signed = await clobClient.createMarketOrder(orderArgs);

        try {
            const resp = await safePostOrder(clobClient, signed, OrderType.FOK);
            remainingUSDC -= shares * askPrice;
            console.log('[BUY SUCCESS]', resp);
        } catch (err) {
            console.log('[BUY FAILED — STOPPING LOOP]');
            break;
        }

        await sleep(ORDER_POST_DELAY);
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

            const maxPriceBid = orderBook.bids.reduce(
                (max, current) => parseFloat(current.price) > parseFloat(max.price) ? current : max,
                orderBook.bids[0]
            );

            console.log('Max price bid:', maxPriceBid);

            const sizeToSell = Math.min(remaining, parseFloat(maxPriceBid.size));
            const order_args = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sizeToSell,
                price: parseFloat(maxPriceBid.price),
                feeRateBps: feeRateBps,
            };

            console.log('Order args:', order_args);

            const signedOrder = await clobClient.createMarketOrder(order_args);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            await sleep(ORDER_POST_DELAY);

            if (resp.success) {
                console.log('Successfully posted order:', resp);
                remaining -= sizeToSell;
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
