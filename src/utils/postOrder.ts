import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

// ===== EXCHANGE FORMAT HELPERS =====
const clampPrice = (p: number) => Math.min(0.999, Math.max(0.001, p));
const formatPriceForOrder = (p: number) => Math.round(clampPrice(p) * 100) / 100; // 2 decimals max
// Taker amount rounding — round down to 4 decimals (max accuracy for API)
const formatTakerAmount = (a: number) => Math.floor(a * 10000) / 10000; // 4 decimals max

const MIN_SHARES = 0.01;
const enforceMinShares = (shares: number) => Math.max(MIN_SHARES, shares);

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);
const FAST_ATTEMPTS = 2;
// ======== COOLDOWN HELPERS ========
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const ORDERBOOK_DELAY = 350;
const RETRY_DELAY = 1200;

const sleepWithJitter = async (ms: number) => {
    const jitter = ms * 0.1 * (Math.random() - 0.5);
    await sleep(ms + jitter);
};

const adaptiveDelay = (baseDelay: number, scale: number) => {
    const factor = Math.min(2, Math.max(0.5, scale / 100));
    return baseDelay * factor;
};

// ========= RPC/API SAFETY WRAPPER =========
const safeCall = async <T>(fn: () => Promise<T>, retries = 3): Promise<T> => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e: any) {
            const retryable = e?.code === 'CALL_EXCEPTION' || e?.code === 'SERVER_ERROR' || e?.message?.includes('timeout');
            if (!retryable || i === retries - 1) throw e;
            console.log(`[RPC RETRY] Attempt ${i + 1} failed, retrying...`);
            await sleep(600);
        }
    }
    throw new Error('Unreachable safeCall state');
};

// ======== EXPOSURE TRACKING ========
// Tracks net shares owned per token (local to this module)
const exposure: Record<string, number> = {};

const updateExposure = (tokenId: string, side: Side, filled: number) => {
    if (!exposure[tokenId]) exposure[tokenId] = 0;
    exposure[tokenId] += side === Side.BUY ? filled : -filled;
    console.log(`[Exposure] Token ${tokenId}: ${exposure[tokenId]} shares`);
};

// 🔥 ADDED — resilient order creation wrapper
const createOrderWithRetry = async (
  clobClient: ClobClient,
  orderArgs: any,
  attempts = 3
) => {
  for (let i = 0; i < attempts; i++) {
    try {
      return await clobClient.createOrder(orderArgs);
    } catch (e: any) {
      const isRpcGlitch =
        e?.code === 'CALL_EXCEPTION' ||
        e?.message?.includes('missing revert data') ||
        e?.message?.includes('header not found') ||
        e?.message?.includes('timeout');

      if (!isRpcGlitch || i === attempts - 1) throw e;

      console.log(`[RPC GLITCH] createOrder retry ${i + 1}/${attempts}`);
      await new Promise(r => setTimeout(r, 400));
    }
  }
};
// ======== HELPER: convert to base units ========
const toBaseUnitsInt = (amount: number, decimals: number) => {
  return Math.ceil(amount * 10 ** decimals); // round up to ensure minimums
};

// ======== HELPER: convert back to float for logging ========
const fromBaseUnitsInt = (amountInt: number, decimals: number) => {
  return amountInt / 10 ** decimals;
};
// ======== HELPER: POST SINGLE ORDER ===================================================================================
const postSingleOrder = async (
  clobClient: ClobClient,
  side: Side,
  tokenId: string,
  amountRaw: number,
  priceRaw: number,
  feeRateBps: number,
  availableBalance?: number
) => {
// ================= PRICE + SIZE NORMALIZATION =================
  const price = formatPriceForOrder(priceRaw);
// Round shares to exchange precision
  const takerAmount = enforceMinShares(formatTakerAmount(amountRaw));
// ================= EXCHANGE COST MATH =================
  const makerAmountFloat = takerAmount * price;
 // Exchange rounds UP to cents
  const makerAmountRounded = Math.ceil(makerAmountFloat * 100) / 100;
// ===== 4️⃣ BALANCE CHECK (BUY ONLY EFFECTIVE) =====
  if (availableBalance !== undefined && makerAmountRounded > availableBalance) {
    console.log(
      `[SKIP ORDER] Insufficient balance: need ${makerAmountRounded}, have ${availableBalance}`
    );
    return 0;
  }
   // ===== 5️⃣ CONVERT TO INTEGERS FOR SIGNING =====
  const takerAmountInt = Math.ceil(takerAmount * 10 ** 4);
  const makerAmountInt = Math.ceil(makerAmountRounded * 10 ** 2);
 // True order cost
  const notional = makerAmountRounded;
 
  
 const order_args = {
    side,
    tokenID: tokenId,
    size: takerAmountInt.toString(), // send integer as string
    price: price.toFixed(2), // keep price string at 2 decimals
    feeRateBps,
    makerAmount: makerAmountInt.toString(), // send integer as string
    takerAmount: takerAmountInt.toString(), // send integer as string
  };
// ===== 6️⃣ BUILD ORDER =====
   console.log('===== FINAL ORDER =====');
  console.log({
    price,
    takerAmount,
    makerAmountRounded,
    takerAmountInt,
    makerAmountInt,
  });

// ===== 7️⃣ SIGN =====
  const signedOrder = await createOrderWithRetry(clobClient, order_args);
  if (!signedOrder) return 0;

  // ===== 8️⃣ POST =====
  const resp = await safeCall(() => clobClient.postOrder(signedOrder, OrderType.FOK));

  if (!resp.success) {
    console.log('Error posting order:', resp.error ?? resp);
    return 0;
  }

  console.log('Successfully posted order');
  updateExposure(tokenId, side, takerAmount);

  return takerAmount; // return shares filled
};

// ======== MAIN POST ORDER FUNCTION ========
const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {
    const marketId = trade.conditionId;
    const tokenId = trade.asset;

    let retry = 0;

    const updateActivity = async () => {
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    };

    let market;
    try {
        market = await safeCall(() => clobClient.getMarket(marketId));
    } catch (err) {
        console.warn(`[CLOB] Could not fetch market fee for ${marketId}, using 0`, err);
        market = { taker_base_fee: 0 };
    }
    console.log('Market info:', market);
    const feeRateBps = market?.taker_base_fee ?? 0;
    const feeMultiplier = 1 + feeRateBps / 10000;
    console.log(`[CLOB] Using feeRateBps: ${feeRateBps}, feeMultiplier: ${feeMultiplier}`);

    console.log(`[Balance] My balance: ${my_balance}, User balance: ${user_balance}`);
    
///// ======== SELL / MERGE ========//////////////////////////////////////////////////////////////////////////////////////////////////
   
    if (condition === 'merge' || condition === 'sell') {
        console.log(`${condition === 'merge' ? 'Merging' : 'Sell'} Strategy...`);
        if (!my_position) {
            console.log('No position to sell/merge');
            await updateActivity();
            return;
        }

        let remaining = my_position.size;

        if (condition === 'sell' && user_position) {
            const ratio = trade.size / (user_position.size + trade.size);
            remaining *= ratio;
        }

        while (remaining > 0 && retry < RETRY_LIMIT) {
            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remaining));

            let orderBook;
            try {
                orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));
                if (!orderBook || !orderBook.bids?.length) {
                    console.log(`No bids for token ${tokenId}, skipping sell`);
                    break;
                }
            } catch (err: any) {
                if (err.response?.status === 404) {
                    console.log(`Token ${tokenId} has no orderbook yet, skipping`);
                    break;
                }
                throw err;
            }

            const maxPriceBid = orderBook.bids.reduce(
                (max, cur) => parseFloat(cur.price) > parseFloat(max.price) ? cur : max,
                orderBook.bids[0]
            );
// ✅ MODIFIED: compute takerAmount based on API rules
            const takerAmount = enforceMinShares(formatTakerAmount(Math.min(remaining, parseFloat(maxPriceBid.size))));

            const filled = await postSingleOrder(
                clobClient,
                Side.SELL,
                tokenId,
                takerAmount, // ✅ modified: use takerAmount
                parseFloat(maxPriceBid.price),
                feeRateBps
            );

            if (!filled) retry++;
            else {
                remaining -= filled;
                retry = 0;
            }

            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
        }

        await updateActivity();
    }

////// ======== BUY ========////////////////////////////////////////////////////////////////////////////////////////////////////
    else if (condition === 'buy') {
        console.log('Buy Strategy...');
        const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
        let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);
        let retry = 0;

        while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remainingUSDC));

            let orderBook;
            try {
                orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));
                if (!orderBook || !orderBook.asks?.length) {
                    console.log(`No asks for token ${tokenId}, skipping buy`);
                    break;
                }
            } catch (err: any) {
                if (err.response?.status === 404) {
                    console.log(`Token ${tokenId} has no orderbook yet, skipping`);
                    break;
                }
                throw err;
            }

            console.log(`Orderbook for token ${tokenId}: top bid ${orderBook.bids?.[0]?.price} (${orderBook.bids?.[0]?.size}), top ask ${orderBook.asks?.[0]?.price} (${orderBook.asks?.[0]?.size})`);

            const minPriceAsk = orderBook.asks.reduce(
                (min, cur) => parseFloat(cur.price) < parseFloat(min.price) ? cur : min,
                orderBook.asks[0]
            );

            const askPriceRaw = parseFloat(minPriceAsk.price);
            const askSize = parseFloat(minPriceAsk.size);

            if (isNaN(askSize) || askSize <= 0) break;
            if (Math.abs(askPriceRaw - trade.price) > 0.05) break;
// Estimate shares affordable
          let estShares = Math.min(
          remainingUSDC / (askPriceRaw * feeMultiplier),
          askSize
          );

// Round exactly like order will
        let sharesToBuy = enforceMinShares(formatTakerAmount(estShares));

      console.log('sharesToBuy:', sharesToBuy);

            let filled = 0;
            try {
                filled = await postSingleOrder(
                    clobClient,
                    Side.BUY,
                    tokenId,
                    sharesToBuy,
                    askPriceRaw,
                    feeRateBps,
                  my_balance
                );
            } catch (err: any) {
                if (err.response?.data?.error) console.log(`Order failed: ${err.response.data.error}`);
                else console.log('Order failed:', err.message || err);
            }

            if (!filled) retry++;
            else {
// Must match postSingleOrder math EXACTLY
            const makerAmountRounded = Math.ceil((filled * askPriceRaw) * 100) / 100;
                  remainingUSDC -= makerAmountRounded * feeMultiplier;
                  retry = 0;
            }

            if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
        }

        await updateActivity();
    } else {
        console.log('Condition not supported');
    }
};

export default postOrder;
