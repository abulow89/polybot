import { ClobClient, OrderType, Side} from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

// ===== EXCHANGE FORMAT HELPERS =============================================================================
const clampPrice = (p: number) => Math.min(0.999, Math.max(0.001, p));
const formatPriceForOrder = (p: number) => Math.round(clampPrice(p) * 100) / 100; // 2 decimals max
//  amount rounding — round down to 4 decimals (max accuracy for API)
const formatTakerAmount = (a: number) => Math.floor(a * 100000) / 100000; // 4 decimals max
const formatMakerAmount = (a: number) => Math.floor(a * 100) / 100;

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);
const FAST_ATTEMPTS = 2;

// ======== COOLDOWN HELPERS ==============================================================================
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
// ========= RPC/API SAFETY WRAPPER =======================================================================
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
// ==================🔥 Resilient order creation wrapper====================================================
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
// ================================= DYNAMIC EXPOSURE TRACKING =========================================
const dynamicExposure: Record<string, number> = {};
const updateDynamicExposure = (
      tokenId: string,
      filled: number,
      side: Side
) => {
const current = dynamicExposure[tokenId] ?? 0;
const newExposure =
    side === Side.BUY
      ? current + filled
      : Math.max(0, current - filled); // never negative
      dynamicExposure[tokenId] = newExposure;
      console.log(
    `[Exposure] ${Side[side]} ${filled} | Token ${tokenId} → ${newExposure} shares`
  );
};
// ===================🔥 Enforce min-order size safely with feeMultiplier==============================
const enforceMinOrder = (
      estShares: number,
      marketMinSafe: number,
      remainingUSDC: number,
      price: number,
      feeMultiplier: number
) => {
     if (estShares >= marketMinSafe) return estShares;
const minCost = marketMinSafe * price * feeMultiplier;
      if (remainingUSDC < minCost) {
        console.log(`[SKIP ORDER] Not enough USDC for minimum order. Remaining: $${remainingUSDC.toFixed(6)}, Needed: $${minCost.toFixed(6)}`);
    return 0;
  }
      console.log(`[MIN ORDER ENFORCED] Bumping ${estShares.toFixed(6)} → ${marketMinSafe} shares`);
  return marketMinSafe;
};
// ================================ POST SINGLE ORDER ====================================================
const postSingleOrder = async (
      clobClient: ClobClient,
      side: Side,
      tokenId: string,
      amountRaw: number,
      priceRaw: number,
      feeRateBps: number,              // ✅ dynamic fee passed in
      marketMinSize: number,
      orderType: OrderType,
      availableBalance?: number,
      trade?: UserActivityInterface
) => {
    if (trade) console.log('Incoming trade at postSingleOrder:', trade);
const price = formatPriceForOrder(priceRaw);
//=========================== Calculate taker amount including fee ====================================
const takerAmountSafe = Math.max(amountRaw, marketMinSize);
const takerAmount = formatTakerAmount(takerAmountSafe);
const feeMultiplier = 1 + feeRateBps / 10000;
// =========================== Adjust size sent to CLOB to account for fees ==============================
const sizeWithFee = formatTakerAmount(takerAmount * feeMultiplier); // 🔹 NEW
const makerAmountFloat = takerAmount * price;
// ✅ FIX: Round to exactly 2 decimals as a NUMBER, not just format for display
const makerAmount = Math.floor(makerAmountFloat * 100) / 100;

const totalCost = makerAmount * feeMultiplier;

    if (availableBalance !== undefined && totalCost > availableBalance) {
      console.log(`[SKIP ORDER] Not enough balance: need ${totalCost}, have ${availableBalance}`);
      return 0;
    }
 // =============================== Pass adjusted size to CLOB ==========================
const orderArgs = {
      side,
      tokenID: tokenId,
      size: sizeWithFee.toFixed(5),       // 🔹 MODIFIED to include fee
      price: price.toFixed(2),
      makerAmount: makerAmount.toFixed(2), // 2 decimals
        feeRateBps
    };
console.log('===== ORDER DEBUG =====');
console.log({
  price: price.toFixed(2),           // ✅ Format for display
  takerAmount: takerAmount.toFixed(5), // ✅ Format for display
  sizeWithFee: sizeWithFee.toFixed(5), // ✅ Format for display
  makerAmountFloat,
  makerAmount: makerAmount.toFixed(2), // ✅ Format for display
  orderArgs,
});
const signedOrder = await createOrderWithRetry(clobClient, orderArgs);
    if (!signedOrder) return 0;
const resp = await safeCall(() => clobClient.postOrder(signedOrder, orderType));
if (!resp.success) {
  const errorMsg = resp.error || 'Unknown error';
  
  // ✅ Only log balance errors once, skip the noise
  if (errorMsg.includes('not enough balance')) {
    console.log('[ORDER FAILED] Insufficient balance/allowance');
  } else if (errorMsg.includes('nonce')) {
    console.log('[ORDER FAILED] Nonce issue');
  } else if (errorMsg.includes('price')) {
    console.log('[ORDER FAILED] Price out of range');
  } else {
    console.log(`[ORDER FAILED] ${errorMsg}`);
  }
  
  return 0;
}
    updateDynamicExposure(tokenId, takerAmount, side);
    return takerAmount;
};
//========================================SMART ORDER TYPE SWITCHER==================================
const executeSmartOrder = async (
      clobClient: ClobClient,
      side: Side,
      tokenId: string,
      shares: number,
      bestPrice: number,
      makerFeeBps: number,           // ✅ kept for maker order
      takerFeeBps: number,           // ✅ kept for taker order
      marketMinSafe: number,
      availableBalance?: number
) => {
const improvement = 0.01;
const makerPrice = side === Side.BUY ? bestPrice - improvement : bestPrice + improvement;
     console.log(`[SMART] Trying MAKER limit first at $${makerPrice.toFixed(2)}`);
//======================= ✅ propagate feeMultiplier to postSingleOrder=================================
const makerFilled = await postSingleOrder(
       clobClient,
       side,
       tokenId,
       shares,
       makerPrice,
       makerFeeBps,            // 🔹 MODIFIED: pass makerFeeBps dynamically
       marketMinSafe,
       OrderType.GTC,
       availableBalance
 );
  if (makerFilled > 0) return makerFilled;
  await sleep(200);
  console.log(`[SMART] Maker didn't fill — switching to IOC taker`);
  return await postSingleOrder(
   clobClient,
   side,
   tokenId,
   shares,
   bestPrice,
   takerFeeBps,            // 🔹 MODIFIED: pass takerFeeBps dynamically
   marketMinSafe,
   'FAK' as OrderType,
   availableBalance
 );
};
//======================= ======== MAIN POST ORDER FUNCTION ========================================
const postOrder = async (
      clobClient: ClobClient,
      condition: string,
      my_position: UserPositionInterface | undefined,
      user_position: UserPositionInterface | undefined,
      trade: UserActivityInterface,
      my_balance: number,
      user_balance: number
) => {
  console.log('Incoming trade detected:', trade);
    if (!trade || !trade.asset || !trade.conditionId || !trade.price) {
  console.warn('[SKIP ORDER] Trade missing required fields:', trade);
      return;
}
const marketId = trade.conditionId;
const tokenId = trade.asset;
const updateActivity = async () => {
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
  };
    let market;
    let makerFeeBps = 0;
    let takerFeeBps = 0;
    try {
          market = await safeCall(() => clobClient.getMarket(marketId));
          makerFeeBps = Number(market?.maker_base_fee ?? 0);
          takerFeeBps = Number(market?.taker_base_fee ?? 0);
} catch (err: any) {
      if (err.response?.status === 404) {
            console.warn(`[CLOB] Market ${marketId} not found`);
    return; // ⚠ return instead of break
  }
  console.warn(`[CLOB] Could not fetch market info for ${marketId}`, err);
  market = { taker_base_fee: 0, maker_base_fee: 0, minimum_order_size: 0 };
}
const marketMinSize = market?.minimum_order_size
  ? parseFloat(market.minimum_order_size)
  : 1;
const marketMinSafe = marketMinSize; // always use numeric safe min for enforceMinOrder
const takerMultiplier = 1 + takerFeeBps / 10000;
    
      console.log(`[Balance] My balance: ${my_balance}, User balance: ${user_balance}`);
// ======== ========================================SELL / MERGE =====================================
    if (condition === 'merge' || condition === 'sell') {
      console.log(`${condition === 'merge' ? 'Merging' : 'Sell'} Strategy...`);
    if (!my_position) {
        console.log('No position to sell/merge');
    await updateActivity();
    return;
  }
    let remaining = my_position.size;
// ==========================✅ Calculate remaining FIRST (for proportional sells)====================
  if (condition === 'sell' && user_position) {
const totalSize = (user_position.size ?? 0) + (trade.size ?? 0);
    if (!trade.size || trade.size <= 0) {
      console.warn('[SKIP SELL] Invalid trade.size');
      await updateActivity();
      return;
    }
const ratio = totalSize > 0 ? (trade.size ?? 0) / totalSize : 0;
    remaining *= ratio;
  }
 //======================= ✅ THEN check if we have enough shares (moved AFTER calculation)=================
  if (remaining > my_position.size) {
    console.log(`[SKIP SELL] Not enough shares. Have: ${my_position.size}, Need: ${remaining}`);
    await updateActivity();
    return;
  }
  let retry = 0;
  while (remaining > 0 && retry < RETRY_LIMIT) {
    if (retry >= FAST_ATTEMPTS) await sleepWithJitter(adaptiveDelay(ORDERBOOK_DELAY, remaining));
    let orderBook;
    try {
      orderBook = await safeCall(() => clobClient.getOrderBook(tokenId));
    } catch (err: any) {
      if (err.response?.status === 404) break;
      throw err;
    }
    if (!orderBook || !Array.isArray(orderBook.bids) || orderBook.bids.length === 0) {
      console.warn(`[SKIP ORDER] Empty bid side for token ${tokenId}`);
      break;
    }
const validBids = orderBook.bids.filter(b =>
      !isNaN(parseFloat(b.price)) && !isNaN(parseFloat(b.size))
    );
    if (validBids.length === 0) {
      console.warn('[SKIP ORDER] No valid bids');
      break;
    }
const maxPriceBid = validBids.reduce(
      (max, cur) => parseFloat(cur.price) > parseFloat(max.price) ? cur : max,
      orderBook.bids[0]
    );
const filled = await executeSmartOrder(
      clobClient,
      Side.SELL,
      tokenId,
      Math.min(remaining, parseFloat(maxPriceBid.size)),
      parseFloat(maxPriceBid.price),
      makerFeeBps,
      takerFeeBps,
      marketMinSafe,
      my_balance
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
// ======================================================= BUY ===================================
  else if (condition === 'buy') {
    console.log('Buy Strategy...');
const userPortfolio = user_balance + (user_position?.size ?? 0) * trade.price;
const tradeUSDC = trade.usdcSize ?? 0;
        if (tradeUSDC <= 0) {
          console.warn('[SKIP ORDER] Trade missing or invalid usdcSize');
          return;
            }
const userExposurePct = tradeUSDC / Math.max(userPortfolio, 1);
// ====================================✅ NEW: Filter by exposure threshold==================================
const MIN_TRADE_SIZE_USD = 0; // Only mirror trades >= ALL
    if (tradeUSDC < MIN_TRADE_SIZE_USD) {
    console.log(`[SKIP ORDER] Trade value too low: $${tradeUSDC.toFixed(6)} < $${MIN_TRADE_SIZE_USD} threshold`);
    await updateActivity();
    return;
  }
  console.log(`✅ HIGH CONVICTION TRADE: ${(userExposurePct*100).toFixed(6)}% exposure, $${tradeUSDC.toFixed(6)} value`);
// ==================================... rest of your existing buy logic=========================================
const myPortfolio = my_balance + (my_position?.size ?? 0) * trade.price;
const targetExposureValue = userExposurePct * (myPortfolio * 11);
const currentExposureValue = (dynamicExposure[tokenId] ?? 0) * trade.price;
    console.log(`[BUY] Mirroring user exposure (relative to balance x11):`);
    console.log(`  User exposure %: ${(userExposurePct*100).toFixed(6)}%`);
    console.log(`  Target exposure for you: $${targetExposureValue.toFixed(6)}`);
    console.log(`  Current exposure: $${currentExposureValue.toFixed(6)}`);
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
} catch (err: any) {
  if (err.response?.status === 404) break;
  throw err;
}
// ============================Validate ASK side (because this is BUY logic)=====================================
if (
  !orderBook ||
  !Array.isArray(orderBook.asks) ||
  orderBook.asks.length === 0
) {
  console.warn(`[SKIP ORDER] Empty ask side for token ${tokenId}`);
  break;
}
// Filter valid asks
const validAsks = orderBook.asks.filter(a =>
  !isNaN(parseFloat(a.price)) &&
  !isNaN(parseFloat(a.size))
);
if (validAsks.length === 0) {
  console.warn('[SKIP ORDER] No valid asks');
  break;
}
// Get lowest ask safely
const minPriceAsk = validAsks.reduce((min, cur) =>
  parseFloat(cur.price) < parseFloat(min.price) ? cur : min
);
      const askPriceRaw = parseFloat(minPriceAsk.price);
            if (!isFinite(askPriceRaw) || askPriceRaw <= 0) break;
      const askSize = parseFloat(minPriceAsk.size);
          if (isNaN(askSize) || askSize <= 0) break;
          if (Math.abs(askPriceRaw - trade.price) > 0.05) break;
let estShares = Math.min(
  remainingUSDC / (askPriceRaw * (1 + takerFeeBps / 10000)),  // 🔹 MODIFIED: dynamic fee
  askSize
);
       estShares = enforceMinOrder(
  estShares,
  marketMinSafe,
  remainingUSDC,
  askPriceRaw,
  1 + takerFeeBps / 10000
);
const estimatedCost = estShares * askPriceRaw * (1 + takerFeeBps / 10000);
    if (estimatedCost > remainingUSDC) {
          console.log('[SKIP ORDER] Insufficient funds for order');
          break;
}
const rawCost = estShares * askPriceRaw;
// Force cost to 2 decimals FIRST
const costRounded = Math.floor(rawCost * 100) / 100; // 2 decimals
// Recalculate shares from rounded cost
const sharesToBuy = formatTakerAmount(costRounded / askPriceRaw); // 4 decimals
// 🔹 NEW: calculate actual order size including fee for logging
const feeMultiplier = 1 + takerFeeBps / 10000;
const sizeWithFee = formatTakerAmount(sharesToBuy * feeMultiplier);
        console.log(`[BUY] Attempting to buy ${sharesToBuy} shares (sizeWithFee sent: ${sizeWithFee}) at $${askPriceRaw.toFixed(4)}`);
        console.log(`  Fee multiplier: ${(1 + takerFeeBps / 10000).toFixed(4)}`);
        console.log(`  Remaining USDC before order: $${remainingUSDC.toFixed(6)}`);
      if (remainingUSDC < 0.0001) break;
const filled = await executeSmartOrder(
  clobClient,
  Side.BUY,
  tokenId,
  sharesToBuy,
  askPriceRaw,
  makerFeeBps,
  takerFeeBps,
  marketMinSafe,
  my_balance
);
      if (!filled) retry++;
      else {
const makerAmountRounded = Math.floor((filled * askPriceRaw) * 100) / 100;
const actualCost = makerAmountRounded * (1 + takerFeeBps / 10000);  // 🔹 MODIFIED
        remainingUSDC -= actualCost;  // ✅ now deduct cost with dynamic fee
                retry = 0;
        console.log(`[BUY FILLED] Bought ${filled} shares at $${askPriceRaw.toFixed(2)} (Cost: $${(makerAmountRounded * takerMultiplier).toFixed(6)})`);
        console.log(`  Remaining USDC after order: $${remainingUSDC.toFixed(6)}`);
        console.log(`  Total dynamic exposure for token ${tokenId}: ${dynamicExposure[tokenId]} shares`);
        console.log(`  Exposure value: $${(dynamicExposure[tokenId]*askPriceRaw).toFixed(6)}`);
        console.log(`Fee multiplier: ${(1 + takerFeeBps / 10000).toFixed(4)}`); // 🔹 MODIFIED
      }
      if (retry >= FAST_ATTEMPTS) await sleepWithJitter(RETRY_DELAY);
    }
    await updateActivity();
  } else {
    console.log('Condition not supported');
  }
};

export default postOrder;
