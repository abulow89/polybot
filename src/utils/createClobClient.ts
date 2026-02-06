import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';

let wsClient: any;

// 🔹 Subscribe to market trades
export const subscribeToMarketTrades = (clobClient: ClobClient, conditionId: string) => {
    wsClient = clobClient.subscribeToMarketTrades(conditionId, (tradeEvent: any) => {
        console.log(`[WS] New trade for ${conditionId}:`, tradeEvent);
    });
};

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

// ✅ Add your two RPC URLs
const RPC_PRIMARY = ENV.RPC_URL1;
const RPC_SECONDARY = ENV.RPC_URL2;

// 🔹 Create CLOB client
const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL as string;

    const providers = [
        new ethers.providers.JsonRpcProvider(RPC_PRIMARY, { name: "matic", chainId }),
        new ethers.providers.JsonRpcProvider(RPC_SECONDARY, { name: "matic", chainId })
    ];

    // Fallback provider = auto failover
    const provider = new ethers.providers.FallbackProvider(providers, 1);

    // Attach provider to wallet
    const wallet = new ethers.Wallet(PRIVATE_KEY as string, provider);

    // Initial client without API key
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
    console.error = function () {};
    let creds = await clobClient.createApiKey();
    console.error = originalConsoleError;

    if (creds.key) {
        console.log('API Key created', creds);
    } else {
        creds = await clobClient.deriveApiKey();
        console.log('API Key derived', creds);
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

    console.log('CLOB client ready:', clobClient);

    return clobClient;
};

export default createClobClient;
