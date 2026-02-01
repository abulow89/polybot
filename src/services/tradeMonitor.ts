import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserPosition = getUserPositionModel(USER_ADDRESS);

let temp_trades: UserActivityInterface[] = [];

const init = async () => {
    temp_trades = (await UserActivity.find().exec()).map((trade) => trade as UserActivityInterface);
    console.log('Loaded temp trades from DB:', temp_trades.length);
};

const fetchTradeData = async () => {
    try {
        const user_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );
        const user_activities: UserActivityInterface[] = await fetchData(
            `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=50&offset=0`
        );

        if (!Array.isArray(user_activities)) {
            console.error('Fetched activities is not an array:', user_activities);
            return;
        }

        console.log(`Fetched ${user_activities.length} activities`);

        await UserPosition.deleteMany({});
        await UserPosition.insertMany(user_positions);

        const currentTimestamp = Math.floor(Date.now() / 1000);

        const new_trades = user_activities
            .filter((activity: UserActivityInterface) => {
                const isDuplicate = temp_trades.some(
                    (existingActivity) => existingActivity.transactionHash === activity.transactionHash
                );
                if (isDuplicate) {
                    console.log('Skipping duplicate trade:', activity.transactionHash);
                }
                return !isDuplicate;
            })
            .filter((activity: UserActivityInterface) => {
                const withinWindow = activity.timestamp + TOO_OLD_TIMESTAMP * 60 * 60 > currentTimestamp;
                if (!withinWindow) {
                    console.log('Skipping old trade:', activity.transactionHash, 'timestamp:', activity.timestamp);
                }
                return withinWindow;
            })
            .map((activity: UserActivityInterface) => ({
                ...activity,
                bot: false,
                botExcutedTime: 0,
            }))
            .sort((a, b) => a.timestamp - b.timestamp);

        console.log('New trades to insert:', new_trades.length);

        temp_trades = [...temp_trades, ...new_trades];
        if (new_trades.length > 0) {
            await UserActivity.insertMany(new_trades);
        }
    } catch (error: any) {
        console.error('Error fetching or inserting trades:', error.message || error);
    }
};

const tradeMonitor = async () => {
    console.log('Trade Monitor is running every', FETCH_INTERVAL, 'seconds');
    await init();

    while (true) {
        await fetchTradeData();
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }
};

export default tradeMonitor;
