import { ClobClient, OrderBuilder } from '@polymarket/clob-client';
import { Trade } from '../models/Trade';

const MAX_SLIPPAGE = 0.05; // 5 cents slippage max
const PRICE_NUDGE = 0.001; // small nudge to ensure order is accepted

export async function postOrder(clobClient: ClobClient, trade: Trade) {
  try {
    console.log('Buy Strategy...');

    // Fetch the order book safely
    const orderBook = await clobClient.getOrderBook(trade.asset, trade._id.toString());
    if (!orderBook) {
      console.log('Order book not found, skipping');
      return;
    }

    // Find the best ask
    const bestAsk = orderBook.asks.reduce((a: any, b: any) => {
      return parseFloat(b.price) > parseFloat(a.price) ? a : b;
    }, orderBook.asks[0]);

    const rawAsk = parseFloat(bestAsk.price);
    if (Math.abs(rawAsk - trade.price) > MAX_SLIPPAGE) {
      console.log('Ask price too far from target — skipping');
      return;
    }

    const askPrice = rawAsk + PRICE_NUDGE;

    // Compute amount in shares (not USD) to allow < $1 orders
    const amountShares = Math.max(trade.amount / askPrice, 0.0001); // min shares 0.0001

    const orderArgs = {
      side: 'BUY',
      tokenID: trade.asset,
      amount: amountShares,
      price: askPrice,
      feeRateBps: 1000, // explicit taker fee
    };

    console.log('Order args:', orderArgs);

    const result = await clobClient.order(orderArgs);

    if (result.success) {
      console.log('Successfully posted order:', result);
    } else {
      console.log('Error posting order, retrying...', result);
    }
  } catch (err) {
    console.error('Error in postOrder:', err);
  }
}
