import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import getMyBalance from '../utils/getMyBalance';
import { mirrorPortfolio, myPortfolio, targetPortfolio } from '../utils/postOrder';

const USER_ADDRESS = ENV.USER_ADDRESS;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;

let temp_trades: UserActivityInterface[] = [];

const UserActivity = getUserActivityModel(USER_ADDRESS);

// Load trades that need processing (not yet executed and under retry limit)
const readTempTrade = async () => {
    temp_trades = (
        await UserActivity.find({
            $and: [
                { type: 'TRADE' },
                { bot: false },
                { botExcutedTime: { $lt: RETRY_LIMIT } },
            ],
        }).exec()
    ).map((trade) => trade as UserActivityInterface);
};

// Execute each trade by updating target portfolio and mirroring
const doTrading = async (clobClient: ClobClient) => {
    for (const trade of temp_trades) {
        const user_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );
        const my_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );

        // Build target portfolio snapshot
        targetPortfolio[trade.asset] = trade.size ?? 0;

        // Build current market prices snapshot
        const marketPrices: Record<string, number> = {};
        if (trade.price) marketPrices[trade.asset] = trade.price;

        const my_balance = await getMyBalance(PROXY_WALLET);

        try {
            // Mirror portfolio to match target allocations
            await mirrorPortfolio(clobClient, marketPrices, my_balance, targetPortfolio);

            // Mark trade as processed
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: trade.botExcutedTime + 1 }
            );
        } catch (err) {
            // If trade fails, increment retry count
            await UserActivity.updateOne(
                { _id: trade._id },
                { botExcutedTime: trade.botExcutedTime + 1 }
            );
        }
    }
};

const tradeExecutor = async (clobClient: ClobClient) => {
    spinner.start('Waiting for new trades...');
    while (true) {
        await readTempTrade();

        if (temp_trades.length > 0) {
            spinner.stop();
            await doTrading(clobClient);
            spinner.start('Waiting for new trades...');
        }

        // Small delay to avoid hammering the DB/API
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

export default tradeExecutor;
