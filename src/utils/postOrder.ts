import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const USER_ADDRESS = ENV.USER_ADDRESS;
const UserActivity = getUserActivityModel(USER_ADDRESS);

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const sleepWithJitter = async (ms: number) => {
  const jitter = ms * 0.1 * (Math.random() - 0.5);
  await sleep(ms + jitter);
};

const clampPrice = (p: number) => Math.min(0.999, Math.max(0.001, p));
const formatPriceForOrder = (p: number) => Math.round(clampPrice(p) * 100) / 100;
const formatTakerAmount = (a: number) => Math.floor(a * 10000) / 10000;

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

const createOrderWithRetry = async (clobClient: ClobClient, orderArgs: any, attempts = 3) => {
  for (let i = 0; i < attempts; i++) {
    try {
      return await clobClient.createOrder(orderArgs);
    } catch (e: any) {
      const isRpcGlitch = e?.code === 'CALL_EXCEPTION' || e?.message?.includes('missing revert data') || e?.message?.includes('header not found') || e?.message?.includes('timeout');
      if (!isRpcGlitch || i === attempts - 1) throw e;
      console.log(`[RPC GLITCH] createOrder retry ${i + 1}/${attempts}`);
      await sleep(400);
    }
  }
};

const executeSmartOrder = async (
  clobClient: ClobClient,
  side: Side,
  tokenId: string,
  shares: number,
  bestPrice: number,
  feeRateBps: number,
  marketMinSize: number,
  feeMultiplier: number,
  availableBalance?: number
) => {
  const improvement = 0.01;
  const makerPrice = side === Side.BUY ? bestPrice - improvement : bestPrice + improvement;

  const filledMaker = await postSingleOrder(
    clobClient,
    side,
    tokenId,
    shares,
    makerPrice,
    feeRateBps,
    marketMinSize,
    OrderType.GTC,
    availableBalance,
    feeMultiplier
  );
  if (filledMaker > 0) return filledMaker;

  await sleep(200);
  return await postSingleOrder(
    clobClient,
    side,
    tokenId,
    shares,
    bestPrice,
    feeRateBps,
    marketMinSize,
    'FAK',
    availableBalance,
    feeMultiplier
  );
};

const postSingleOrder = async (
  clobClient: ClobClient,
  side: Side,
  tokenId: string,
  amountRaw: number,
  priceRaw: number,
  feeRateBps: number,
  marketMinSize: number,
  orderType: OrderType | 'FAK',
  availableBalance?: number,
  feeMultiplier: number = 1
) => {
  const price = formatPriceForOrder(priceRaw);
  const takerAmount = formatTakerAmount(Math.max(amountRaw, marketMinSize));
  const totalCost = takerAmount * price * feeMultiplier;

  if (availableBalance !== undefined && totalCost > availableBalance) {
    console.log(`[SKIP ORDER] Not enough balance. Need ${totalCost}, have ${availableBalance}`);
    return 0;
  }

  const orderArgs = { side, tokenID: tokenId, size: takerAmount.toString(), price: price.toFixed(2) };
  const signedOrder = await createOrderWithRetry(clobClient, orderArgs);
  if (!signedOrder) return 0;

  const resp = await safeCall(() => clobClient.postOrder(signedOrder, OrderType as any));
  if (!resp.success) {
    console.log('Error posting order:', resp.error ?? resp);
    return 0;
  }
  return takerAmount;
};

// ================== Portfolio Mirroring Logic ==================
const myPortfolio: Record<string, number> = {};
const targetPortfolio: Record<string, number> = {};

const mirrorPortfolio = async (
  clobClient: ClobClient,
  marketPrices: Record<string, number>,
  myBalance: number,
  targetPositions: Record<string, number>
) => {
  // Compute total portfolio values
  const targetTotal = Object.entries(targetPositions).reduce(
    (sum, [token, shares]) => sum + shares * (marketPrices[token] ?? 0),
    0
  );
  const myTotal = myBalance + Object.entries(myPortfolio).reduce(
    (sum, [token, shares]) => sum + shares * (marketPrices[token] ?? 0),
    0
  );

  for (const [tokenId, targetShares] of Object.entries(targetPositions)) {
    const price = marketPrices[tokenId];
    if (!price) continue;

    const targetValue = targetShares * price;
    const targetWeight = targetTotal > 0 ? targetValue / targetTotal : 0;
    const desiredValue = targetWeight * myTotal;
    const currentValue = (myPortfolio[tokenId] ?? 0) * price;
    const deltaValue = desiredValue - currentValue;

    if (Math.abs(deltaValue) < 0.0001) continue; // skip tiny adjustments

    const side = deltaValue > 0 ? Side.BUY : Side.SELL;
    const sharesToTrade = Math.abs(deltaValue) / price;

    console.log(`[MIRROR] ${side === Side.BUY ? 'Buying' : 'Selling'} ${sharesToTrade.toFixed(4)} of ${tokenId} at $${price}`);

    const market = await safeCall(() => clobClient.getMarket(tokenId));
    const feeMultiplier = 1 + (market?.taker_base_fee ?? 0) / 10000;
    const marketMinSize = market?.min_order_size ?? 1;

    const filled = await executeSmartOrder(
      clobClient,
      side,
      tokenId,
      sharesToTrade,
      price,
      market?.taker_base_fee ?? 0,
      marketMinSize,
      feeMultiplier,
      myBalance
    );

    if (!myPortfolio[tokenId]) myPortfolio[tokenId] = 0;
    myPortfolio[tokenId] += side === Side.BUY ? filled : -filled;
    myBalance -= filled * price * feeMultiplier;
  }
};

export { mirrorPortfolio, myPortfolio, targetPortfolio };
