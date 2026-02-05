import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

// ===== EXCHANGE FORMAT HELPERS =====
const clampPrice = (p: number) => Math.min(0.999, Math.max(0.001, p));
const formatPriceForOrder = (p: number) => Math.round(clampPrice(p) * 100) / 100; // 2 decimals max
// Taker amount rounding — round down to 4 decimals (max accuracy for API)
const formatTakerAmount = (a: number) => Math.floor(a * 10000) / 10000; // 4 decimals max

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
// ======== HELPER: enforce market minimum and rounding ========
const enforceMarketMinShares = (shares: number, marketMin?: number) => {
  const min = marketMin ?? 0;
  let adjusted = Math.max(shares, min);
  if (adjusted > shares) console.log(`[MIN ORDER] Amount bumped from ${shares} → ${adjusted}`);
  return formatTakerAmount(adjusted);
};
// ======== POST SINGLE ORDER (simplified) ===================================================================================
const postSingleOrder = async (
  clobClient: ClobClient,
  side: Side,
  tokenId: string,
  amountRaw: number,
  priceRaw: number,
  feeRateBps: number,
  availableBalance?: number,
  market?: { minOrderSize?: number }
) => {
  const marketMinSize = market?.minOrderSize ?? 0;

  // ================= PRICE + SIZE NORMALIZATION =================
  const price = formatPriceForOrder(priceRaw);

  // Round shares to exchange precision and enforce market minimum
  const takerAmount = enforceMarketMinShares(amountRaw, marketMinSize);

  // ================= EXCHANGE COST MATH =================
  const makerAmountFloat = takerAmount * price;
  const makerAmountRounded = Math.ceil(makerAmountFloat * 100) / 100; // round up to cents

  // ===== BALANCE CHECK (BUY ONLY EFFECTIVE) =====
  if (availableBalance !== undefined && makerAmountRounded > availableBalance) {
    console.log(
      `[SKIP ORDER] Insufficient balance: need ${makerAmountRounded}, have ${availableBalance}`
    );
    return 0;
  }

  // ===== CONVERT TO INTEGERS FOR SIGNING =====
  const USDC_DECIMALS = 6;
  const SHARE_DECIMALS = 4;
  const takerAmountInt = Math.ceil(takerAmount * 10 ** SHARE_DECIMALS);
  const makerAmountInt = Math.ceil(makerAmountRounded * 10 ** USDC_DECIMALS);

  const order_args = {
    side,
    tokenID: tokenId,
    size: takerAmountInt.toString(),
    price: price.toFixed(2),
    feeRateBps,
    makerAmount: makerAmountInt.toString(),
    takerAmount: takerAmountInt.toString(),
  };

  console.log('===== FINAL ORDER =====', {
    price,
    takerAmount,
    makerAmountRounded,
    takerAmountInt,
    makerAmountInt,
  });

  const signedOrder = await createOrderWithRetry(clobClient, order_args);
  if (!signedOrder) return 0;

  const resp = await safeCall(() => clobClient.postOrder(signedOrder, OrderType.FOK));
  if (!resp.success) {
    console.log('Error posting order:', resp.error ?? resp);
    return 0;
  }

  console.log('Successfully posted order');
  updateExposure(tokenId, side, takerAmount);

  return takerAmount;
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

  const updateActivity = async () => {
    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
  };

  let market;
  try {
    market = await safeCall(() => clobClient.getMarket(marketId));
  } catch (err) {
    console.warn(`[CLOB] Could not fetch market fee for ${marketId}, using 0`, err);
    market = { taker_base_fee: 0, minOrderSize: 0 };
  }

  const feeRateBps = market?.taker_base_fee ?? 0;
  const feeMultiplier = 1 + feeRateBps / 10000;
  const marketMinSize = market?.minOrderSize ?? 0;

  console.log('Market info:', market);
  console.log(`[CLOB] Using feeRateBps: ${feeRateBps}, feeMultiplier: ${feeMultiplier}`);
  console.log(`[Balance] My balance: ${my_balance}, User balance: ${user_balance}`);

  // ======== SELL / MERGE ========
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

    let retry = 0;
    while (remaining > 0 && retry < RETRY_LIMIT) {
      if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remaining));

      let orderBook;
      try {
        orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));
        if (!orderBook || !orderBook.bids?.length) break;
      } catch (err: any) {
        if (err.response?.status === 404) break;
        throw err;
      }

      const maxPriceBid = orderBook.bids.reduce(
        (max, cur) => parseFloat(cur.price) > parseFloat(max.price) ? cur : max,
        orderBook.bids[0]
      );

      // ✅ enforce market minimum internally in postSingleOrder
      const filled = await postSingleOrder(
        clobClient,
        Side.SELL,
        tokenId,
        Math.min(remaining, parseFloat(maxPriceBid.size)),
        parseFloat(maxPriceBid.price),
        feeRateBps,
        undefined,
        market
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

  // ======== BUY ========
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
        if (!orderBook || !orderBook.asks?.length) break;
      } catch (err: any) {
        if (err.response?.status === 404) break;
        throw err;
      }

      const minPriceAsk = orderBook.asks.reduce(
        (min, cur) => parseFloat(cur.price) < parseFloat(min.price) ? cur : min,
        orderBook.asks[0]
      );

      const askPriceRaw = parseFloat(minPriceAsk.price);
      const askSize = parseFloat(minPriceAsk.size);
      if (isNaN(askSize) || askSize <= 0) break;
      if (Math.abs(askPriceRaw - trade.price) > 0.05) break;

      let estShares = Math.min(remainingUSDC / (askPriceRaw * feeMultiplier), askSize);

      const filled = await postSingleOrder(
        clobClient,
        Side.BUY,
        tokenId,
        estShares,
        askPriceRaw,
        feeRateBps,
        my_balance,
        market
      );

      if (!filled) retry++;
      else {
        const makerAmountRounded = Math.ceil(filled * askPriceRaw * 100) / 100;
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
