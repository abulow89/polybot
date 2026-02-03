import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

const USER_ADDRESS = ENV.USER_ADDRESS;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserPosition = getUserPositionModel(USER_ADDRESS);

let temp_trades: UserActivityInterface[] = [];

// Load previously seen trades
const init = async () => {
    temp_trades = (await UserActivity.find().exec()).map(
        (trade) => trade as UserActivityInterface
    );
};

// Fetch the latest trades from the API
const fetchTradeData = async () => {
    const user_positions: UserPositionInterface[] = await fetchData(
        `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
    );
    const user_activities: UserActivityInterface[] = await fetchData(
        `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=5&offset=0`
    );

    await UserPosition.deleteMany({});
    await UserPosition.insertMany(user_positions);

    try {
        // Only keep trades we haven’t seen yet
        const new_trades = user_activities
            .filter(
                (activity: UserActivityInterface) =>
                    !temp_trades.some(
                        (existingActivity) =>
                            existingActivity.transactionHash === activity.transactionHash
                    )
            )
            .map((activity: UserActivityInterface) => ({
                ...activity,
                bot: false,
                botExcutedTime: 0,
            }))
            .sort((a, b) => a.timestamp - b.timestamp);

        if (new_trades.length > 0) {
            temp_trades.push(...new_trades);
            await UserActivity.insertMany(new_trades);
        }
    } catch (error) {
        console.error('Error inserting new trades:', error);
    }
};

const tradeMonitor = async () => {
    await init(); // Load previous trades

    while (true) {
        await fetchTradeData();
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }
};

export default tradeMonitor;
