const MIN_PRICE = 0.01;   // minimum allowed price on CLOB
const MAX_PRICE = 0.99;   // maximum allowed price on CLOB
const MIN_USD_ORDER = 0.01; // minimum order value in USD

// ================= BUY =================
else if (condition === 'buy') {
    console.log('Buy Strategy...');
    const ratio = Math.min(1, my_balance / Math.max(user_balance, 1));
    let remainingUSDC = Math.min(trade.usdcSize * ratio, my_balance);
    let retry = 0;

    while (remainingUSDC >= MIN_USD_ORDER && retry < RETRY_LIMIT) {
        const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
        if (!orderBook) return; // 404 terminal
        if (!orderBook.asks?.length) break;

        const bestAsk = orderBook.asks.reduce(
            (a, b) => parseFloat(b.price) < parseFloat(a.price) ? b : a
        );

        // clamp price to allowed range
        let askPrice = Math.min(MAX_PRICE, Math.max(MIN_PRICE, parseFloat(bestAsk.price) + PRICE_NUDGE));

        const maxSharesAtLevel = parseFloat(bestAsk.size);
        let affordableShares = remainingUSDC / askPrice;

        // enforce minimum order value
        if (affordableShares * askPrice < MIN_USD_ORDER) {
            console.log('Order value below minimum — skipping');
            break;
        }

        const sharesToBuy = Math.min(maxSharesAtLevel, affordableShares);

        if (sharesToBuy <= 0) break;

        const order_args = {
            side: Side.BUY,
            tokenID: trade.asset,
            amount: sharesToBuy,
            price: askPrice,
            feeRateBps: 1000
        };

        console.log('Order args:', order_args);

        const signedOrder = await clobClient.createMarketOrder(order_args);
        const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

        if (resp.success) {
            remainingUSDC -= sharesToBuy * askPrice;
            console.log('Successfully posted order:', resp);
            retry = 0;
        } else {
            retry++;
            console.log('Error posting order: retrying...', resp);
        }
    }

    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
}

// ================= SELL =================
else if (condition === 'sell') {
    console.log('Sell Strategy...');
    if (!my_position || my_position.asset !== trade.asset) {
        console.log('No position to sell');
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return;
    }

    const userPrevSize = (user_position?.size || 0) + trade.size;
    const reductionPct = userPrevSize > 0 ? trade.size / userPrevSize : 1;

    let remaining = my_position.size * reductionPct;
    let retry = 0;

    while (remaining > 0 && retry < RETRY_LIMIT) {
        const orderBook = await getOrderBookSafe(clobClient, trade.asset, trade._id.toString());
        if (!orderBook) return; // 404 terminal
        if (!orderBook.bids?.length) break;

        const bestBid = orderBook.bids.reduce(
            (a, b) => parseFloat(b.price) > parseFloat(a.price) ? b : a
        );

        let bidPrice = Math.min(MAX_PRICE, Math.max(MIN_PRICE, parseFloat(bestBid.price) - PRICE_NUDGE));
        const sizeToSell = Math.min(remaining, parseFloat(bestBid.size));

        // enforce minimum order value
        if (sizeToSell * bidPrice < MIN_USD_ORDER) {
            console.log('Order value below minimum — skipping');
            break;
        }

        const order_args = {
            side: Side.SELL,
            tokenID: trade.asset,
            amount: sizeToSell,
            price: bidPrice,
            feeRateBps: 1000
        };

        console.log('Order args:', order_args);

        const signedOrder = await clobClient.createMarketOrder(order_args);
        const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

        if (resp.success) {
            remaining -= sizeToSell;
            console.log('Successfully posted order:', resp);
            retry = 0;
        } else {
            retry++;
            console.log('Error posting order: retrying...', resp);
        }
    }

    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
}
