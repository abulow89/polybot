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
console.log("RPC_PRIMARY:", RPC_PRIMARY);
console.log("RPC_SECONDARY:", RPC_SECONDARY);

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL as string;

    // Create providers for FallbackProvider
    const providers = [
        new ethers.providers.JsonRpcProvider(RPC_PRIMARY, { name: "matic", chainId }),
        new ethers.providers.JsonRpcProvider(RPC_SECONDARY, { name: "matic", chainId })
    ];

    // The second argument '1' means quorum=1, i.e., any single provider responding is enough
    const provider = new ethers.providers.FallbackProvider(providers, 1);

    // Test provider before creating wallet
    try {
        const block = await provider.getBlockNumber();
        console.log("✅ Connected to Polygon network, latest block:", block);
    } catch (err) {
        console.error("❌ FallbackProvider could not connect to any RPC:", err);
        throw err;
    }

    // Attach provider to wallet
    const wallet = new ethers.Wallet(PRIVATE_KEY as string, provider);
    console.log("Wallet created, address:", wallet.address);

    // Initialize ClobClient without creds first
    let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        SignatureType.POLY_GNOSIS_SAFE,
        PROXY_WALLET as string,
    );

    // Suppress console errors temporarily
    const originalConsoleError = console.error;
    console.error = function () {};

    let creds;
    try {
        creds = await clobClient.createApiKey();
        console.log("API Key created", creds);
    } catch (err) {
        console.warn("createApiKey failed, deriving instead...");
        creds = await clobClient.deriveApiKey();
        console.log("API Key derived", creds);
    }

    console.error = originalConsoleError;

    // Re-initialize ClobClient with credentials
    clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        creds,
        SignatureType.POLY_GNOSIS_SAFE,
        PROXY_WALLET as string,
    );

    console.log("ClobClient ready:", clobClient);
    return clobClient;
};

export default createClobClient;
