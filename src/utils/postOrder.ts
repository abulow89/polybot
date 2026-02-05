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
  const min = marketMin ?? 0.001;
  const adjusted = Math.max(shares, min); // bump to market minimum first
  if (adjusted > shares) console.log(`[MIN ORDER] Amount bumped from ${shares} → ${adjusted}`);
  return formatTakerAmount(adjusted); // then round down to 4 decimals
};;
// ======== DYNAMIC EXPOSURE TRACKING ========
// Tracks filled shares per token in this session
const dynamicExposure: Record<string, number> = {};

// Call after a successful fill to update exposure
const updateDynamicExposure = (tokenId: string, filled: number) => {
  if (!dynamicExposure[tokenId]) dynamicExposure[tokenId] = 0;
  dynamicExposure[tokenId] += filled;
  console.log(`[Exposure] Token ${tokenId}: ${dynamicExposure[tokenId]} shares`);
};
// ======== POST SINGLE ORDER ====================================================
const postSingleOrder = async (
  clobClient: ClobClient,
  side: Side,
  tokenId: string,
  takerAmount: number,
  priceRaw: number,
  feeRateBps: number,
  availableBalance?: number,
  market?: { minOrderSize?: number },
  feeMultiplier?: number
) => {
  const marketMinSize = market?.minOrderSize ?? 0.001;
  const effectiveFeeMultiplier = feeMultiplier ?? 1;

  const price = formatPriceForOrder(priceRaw);
  const takerAmountSafe = Math.max(takerAmount, 0.0001); // enforce min
  const takerAmountFinal = enforceMarketMinShares(takerAmountSafe, marketMinSize);

  const makerAmount = takerAmountFinal * price;

  if (availableBalance !== undefined && makerAmount * effectiveFeeMultiplier > availableBalance) {
    console.log(`[SKIP ORDER] Not enough balance: need ${makerAmount * effectiveFeeMultiplier}, have ${availableBalance}`);
    return 0;
  }

  const orderArgs = {
    side,
    tokenID: tokenId,
    size: takerAmountFinal.toFixed(4),
    price: price.toFixed(2),
    feeRateBps,
   makerAmount: Math.floor(makerAmount * 1e6).toString(),
  takerAmount: Math.floor(takerAmountFinal * 1e4).toString(),
  };

  const signedOrder = await createOrderWithRetry(clobClient, orderArgs);
  if (!signedOrder) return 0;

  const resp = await safeCall(() => clobClient.postOrder(signedOrder, OrderType.FOK));
  if (!resp.success) {
    console.log('Error posting order:', resp.error ?? resp);
    return 0;
  }

  updateDynamicExposure(tokenId, takerAmountFinal);
  return takerAmountFinal;
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
  const marketMinSize = market?.minOrderSize ?? 0.001;

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

      const filled = await postSingleOrder(
        clobClient,
        Side.SELL,
        tokenId,
        Math.min(remaining, parseFloat(maxPriceBid.size)),
        parseFloat(maxPriceBid.price),
        feeRateBps,
        undefined,
        market,
        feeMultiplier
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

  // ======== BUY =============================================================================================================
  else if (condition === 'buy') {
    console.log('Buy Strategy...');

    // ===== DYNAMIC EXPOSURE CALCULATION (MIRROR USER EXPOSURE + SCALE) =====
    const userPortfolio = user_balance + (user_position?.size ?? 0) * trade.price;
    const userExposurePct = trade.usdcSize / Math.max(userPortfolio, 1);

    // Scale your exposure proportional to your balance relative to the user
    const myPortfolio = my_balance + (my_position?.size ?? 0) * trade.price;
    const targetExposureValue = userExposurePct * (myPortfolio*10);

    const currentExposureValue = (dynamicExposure[tokenId] ?? 0) * trade.price;
      
    console.log(`[BUY] Mirroring user exposure (scaled by x10):`);
    console.log(`  User exposure %: ${(userExposurePct*100).toFixed(2)}%`);
    console.log(`  Target exposure for you: $${targetExposureValue.toFixed(2)}`);
    console.log(`  Current exposure: $${currentExposureValue.toFixed(2)}`);
    let remainingUSDC = Math.max(0, targetExposureValue - currentExposureValue);
    remainingUSDC = Math.min(remainingUSDC, my_balance);


    console.log(`  Remaining USDC to spend: $${remainingUSDC.toFixed(6)}`);

    let retry = 0;
    while (remainingUSDC > 0 && retry < RETRY_LIMIT) {
      if (retry >= FAST_ATTEMPTS) 
        await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remainingUSDC));

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

 // --- NEW: enforce minimum dynamic order size ---
    const marketMinSafe = marketMinSize > 0 ? marketMinSize : 0.001;
    // Calculate max shares you can afford with remaining USDC
    let estShares = Math.min(remainingUSDC / askPriceRaw, askSize);
    // Enforce the market minimum dynamically
    if (estShares < marketMinSafe) {
      const minCost = marketMinSafe * askPriceRaw * feeMultiplier;
      
        if (remainingUSDC < minCost) {
        console.log(`[SKIP ORDER] Not enough USDC to cover minimum order size. Remaining: $${remainingUSDC.toFixed(6)}, Needed: $${minCost.toFixed(6)}`);
        break; // skip this order
      }
        console.log(`[MIN ORDER ENFORCED] Bumping order from ${estShares.toFixed(6)} → ${marketMinSafe} shares to meet minimum order size`);
      estShares = marketMinSafe;
    }
      estShares = enforceMarketMinShares(estShares, marketMinSafe); // existing rounding

      console.log(`[BUY] Attempting to buy up to ${estShares} shares at $${askPriceRaw.toFixed(2)}`);
      console.log(`  Fee multiplier: ${feeMultiplier.toFixed(4)}`);
      console.log(`  Remaining USDC before order: $${remainingUSDC.toFixed(6)}`);
// Build order args for logging (mirrors what postSingleOrder will do)
const takerAmountFinal = enforceMarketMinShares(Math.max(estShares, marketMinSafe), marketMinSafe);
const price = formatPriceForOrder(askPriceRaw);
const makerAmount = takerAmountFinal * price;

const orderArgsLog = {
  side: Side.BUY,
  tokenID: tokenId,
  size: takerAmountFinal.toString(),
  price: price.toFixed(2),
  feeRateBps,
  makerAmount: Math.floor(makerAmount * 1e6).toString(),
  takerAmount: Math.floor(takerAmountFinal * 1e4).toString(),
  feeMultiplier,
};

console.log('  [ORDER ARGS]', orderArgsLog);

      if (remainingUSDC < 0.0001) {
        console.log(`[SKIP ORDER] Remaining USDC too low (${remainingUSDC.toFixed(6)}), skipping...`);
        break;
      }

      const filled = await postSingleOrder(
        clobClient,
        Side.BUY,
        tokenId,
        estShares,
        askPriceRaw,
        feeRateBps,
        my_balance,
        market,
        feeMultiplier
      );

      if (!filled) retry++;
      else {
        const totalCost = filled * askPriceRaw * feeMultiplier;
        remainingUSDC -= totalCost;
        retry = 0;

        console.log(`[BUY FILLED] Bought ${filled} shares at $${askPriceRaw.toFixed(2)} (Cost: $${totalCost.toFixed(6)})`);
        console.log(`  Remaining USDC after order: $${remainingUSDC.toFixed(6)}`);
        console.log(`  Total dynamic exposure for token ${tokenId}: ${dynamicExposure[tokenId]} shares`);
        console.log(`  Exposure value: $${(dynamicExposure[tokenId]*askPriceRaw).toFixed(6)}`);
      }

      if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
    }

    await updateActivity();
  }

  else {
    console.log('Condition not supported');
  }
};

export default postOrder;
