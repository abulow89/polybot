import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';

let wsClient: any;

// 🔹 Subscribe to market trades and log user activity
export const subscribeToMarketTrades = (clobClient: ClobClient, conditionId: string) => {
    wsClient = clobClient.subscribeToMarketTrades(conditionId, (tradeEvent: any) => {
        const { price, size, side, outcome, user } = tradeEvent;
        console.log(`[WS] New trade for ${conditionId}:`);
        console.log(`  User: ${user.username || user.address}`);
        console.log(`  Side: ${side}`);
        console.log(`  Outcome: ${outcome}`);
        console.log(`  Shares: ${size}`);
        console.log(`  Price: $${price}`);
    });
};

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

// RPC URLs
const RPC_PRIMARY = ENV.RPC_URL1;
const RPC_SECONDARY = ENV.RPC_URL2;

// 🔹 Create CLOB client with fallback provider and API key
export const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL as string;

    const providers = [
        new ethers.providers.JsonRpcProvider(RPC_PRIMARY, { name: 'matic', chainId }),
        new ethers.providers.JsonRpcProvider(RPC_SECONDARY, { name: 'matic', chainId }),
    ];

    const provider = new ethers.providers.FallbackProvider(providers, 1);
    const wallet = new ethers.Wallet(PRIVATE_KEY as string, provider);

    let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        SignatureType.POLY_GNOSIS_SAFE,
        PROXY_WALLET as string,
    );

    // Create or derive API key
    const originalConsoleError = console.error;
    console.error = () => {};
    let creds = await clobClient.createApiKey();
    console.error = originalConsoleError;

    if (!creds.key) {
        creds = await clobClient.deriveApiKey();
        console.log('API Key derived', creds);
    } else {
        console.log('API Key created', creds);
    }

    // Recreate client with API credentials
    clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        creds,
        SignatureType.POLY_GNOSIS_SAFE,
        PROXY_WALLET as string,
    );

    console.log('CLOB client ready');
    return clobClient;
};

// 🔹 Example: create client and subscribe to trades
export const initTradingMonitor = async (conditionId: string) => {
    const clobClient = await createClobClient();
    subscribeToMarketTrades(clobClient, conditionId);
};

export default createClobClient;
