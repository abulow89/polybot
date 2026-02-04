import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

// ✅ ADD YOUR TWO RPC URLS TO ENV
const RPC_PRIMARY = ENV.RPC_URL1;
const RPC_SECONDARY = ENV.RPC_URL2;

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL as string;
    
    const providers = [
    new ethers.providers.JsonRpcProvider(RPC_PRIMARY, { name: "matic", chainId: 137 }),
    new ethers.providers.JsonRpcProvider(RPC_SECONDARY, { name: "matic", chainId: 137 })
];

// Fallback provider = auto failover
const provider = new ethers.providers.FallbackProvider(providers, 1);

// Attach provider to wallet
const wallet = new ethers.Wallet(PRIVATE_KEY as string, provider);
    let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        SignatureType.POLY_GNOSIS_SAFE,
        PROXY_WALLET as string,
    );

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

    clobClient = new ClobClient(
    host,
    chainId,
    wallet,
    creds,
    SignatureType.POLY_GNOSIS_SAFE,
    PROXY_WALLET as string,
    provider // ⭐ FIX
    );
    console.log(clobClient);
    return clobClient;
    };

export default createClobClient;
