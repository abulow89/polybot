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
    
    const tryProvider = async (url: string) => {
  const provider = new ethers.providers.JsonRpcProvider(url);
  await provider.getBlockNumber(); // test RPC
  return provider;
};

let provider;

try {
  provider = await tryProvider(RPC_PRIMARY);
  console.log("✅ Using PRIMARY RPC");
} catch (err) {
  console.warn("⚠️ Primary RPC failed, switching to secondary...");
  provider = await tryProvider(RPC_SECONDARY);
  console.log("✅ Using SECONDARY RPC");
}
    
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
   let creds;

try {
  creds = await clobClient.createApiKey();
} catch (err) {
  console.warn("createApiKey failed, deriving instead...");
  creds = await clobClient.deriveApiKey();
}

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
    );
    console.log(clobClient);
    return clobClient;
    };

export default createClobClient;
