import * as dotenv from 'dotenv';
dotenv.config();

if (!process.env.USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}
if (!process.env.PROXY_WALLET) {
    throw new Error('PROXY_WALLET is not defined');
}
if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY is not defined');
}
if (!process.env.CLOB_HTTP_URL) {
    throw new Error('CLOB_HTTP_URL is not defined');
}
if (!process.env.CLOB_WS_URL) {
    throw new Error('CLOB_WS_URL is not defined');
}
if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined');
}
if (!process.env.RPC_URL1) {
    throw new Error('RPC_URL1 is not defined');
}
if (!process.env.RPC_URL2) {
    throw new Error('RPC_URL2 is not defined');
}
if (!process.env.USDC_CONTRACT_ADDRESS) {
    throw new Error('USDC_CONTRACT_ADDRESS is not defined');
}

export const ENV = {
    USER_ADDRESS: process.env.USER_ADDRESS as string,
    PROXY_WALLET: process.env.PROXY_WALLET as string,
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL as string,
    CLOB_WS_URL: process.env.CLOB_WS_URL as string,
    FETCH_INTERVAL: parseInt(process.env.FETCH_INTERVAL || '1', 10),
    TOO_OLD_TIMESTAMP: parseInt(process.env.TOO_OLD_TIMESTAMP || '24', 10),
    RETRY_LIMIT: parseInt(process.env.RETRY_LIMIT || '3', 10),
    MONGO_URI: process.env.MONGO_URI as string,
    RPC_URL1: process.env.RPC_URL1 as string,
    RPC_URL2: process.env.RPC_URL2 as string,
    USDC_CONTRACT_ADDRESS: process.env.USDC_CONTRACT_ADDRESS as string,
    MIN_EXPOSURE_PCT: parseFloat(process.env.MIN_EXPOSURE_PCT || '0.05'),
    MIN_TRADE_SIZE_USD: parseFloat(process.env.MIN_TRADE_SIZE_USD || '3000'),
};
