import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';

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

// Execute each trade
const doTrading = async (clobClient: ClobClient) => {
    for (const trade of temp_trades) {
        const user_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );
        const my_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );

        const my_position = my_positions.find(
            (pos) => pos.conditionId === trade.conditionId
        );
        const user_position = user_positions.find(
            (pos) => pos.conditionId === trade.conditionId
        );

        const my_balance = await getMyBalance(PROXY_WALLET);
        const user_balance = await getMyBalance(USER_ADDRESS);

        try {
            if (trade.side === 'BUY') {
                if (user_position && my_position && my_position.asset !== trade.asset) {
                    await postOrder(clobClient, 'merge', my_position, user_position, trade, my_balance, user_balance);
                } else {
                    await postOrder(clobClient, 'buy', my_position, user_position, trade, my_balance, user_balance);
                }
            } else if (trade.side === 'SELL') {
                await postOrder(clobClient, 'sell', my_position, user_position, trade, my_balance, user_balance);
            } else {
                // Unsupported trade type, mark as done
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, botExcutedTime: trade.botExcutedTime + 1 }
                );
            }

            // Mark successful trades
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
