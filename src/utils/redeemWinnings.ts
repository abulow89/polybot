import { ethers } from 'ethers';
import { redeemPositions } from './ctfOperations';
import { ENV } from '../config/env';

/**
 * Redeem all resolved markets
 * Run this periodically or manually after markets resolve
 */
export const redeemAllResolvedMarkets = async (conditionIds: string[]) => {
  const signer = new ethers.Wallet(ENV.PRIVATE_KEY, new ethers.providers.JsonRpcProvider(ENV.RPC_URL));
  
  for (const conditionId of conditionIds) {
    try {
      await redeemPositions(conditionId, signer);
      console.log(`✅ Redeemed: ${conditionId}`);
    } catch (err: any) {
      if (err.message.includes('no payout')) {
        console.log(`⏳ Not resolved yet: ${conditionId}`);
      } else {
        console.error(`❌ Redeem failed: ${conditionId}`, err.message);
      }
    }
  }
};
