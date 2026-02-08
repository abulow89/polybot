import { redeemAllResolvedMarkets } from '../utils/redeemWinnings';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const UserActivity = getUserActivityModel(ENV.USER_ADDRESS);
const REDEEM_INTERVAL = 30 * 1000; // 30 seconds in milliseconds

/**
 * Background service that checks and redeems resolved markets every 2 minutes
 */
export class RedeemService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Start the redemption service
   */
  start() {
    if (this.isRunning) {
      console.log('[REDEEM SERVICE] Already running');
      return;
    }

    console.log('[REDEEM SERVICE] Starting... Will check every 2 minutes');
    this.isRunning = true;

    // Run immediately on start
    this.checkAndRedeem();

    // Then run every 2 minutes
    this.intervalId = setInterval(() => {
      this.checkAndRedeem();
    }, REDEEM_INTERVAL);
  }

  /**
   * Stop the redemption service
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log('[REDEEM SERVICE] Stopped');
    }
  }

  /**
   * Check for resolved markets and redeem them
   */
  private async checkAndRedeem() {
  try {
    console.log('[REDEEM SERVICE] Checking for resolved markets...');

    // Get unredeemed markets from database
    const markets = await MarketToRedeem.find({ redeemed: false });
    
    if (!markets || markets.length === 0) {
      console.log('[REDEEM SERVICE] No markets to redeem');
      return;
    }

    const conditionIds = markets.map(m => m.conditionId);
    console.log(`[REDEEM SERVICE] Checking ${conditionIds.length} markets`);

    for (const market of markets) {
      try {
        await redeemPositions(market.conditionId, signer);
        
        // Mark as redeemed
        await MarketToRedeem.updateOne(
          { _id: market._id },
          { redeemed: true, redeemedAt: new Date() }
        );
        
        console.log(`✅ Redeemed: ${market.conditionId}`);
      } catch (err: any) {
        if (!err.message.includes('no payout')) {
          console.error(`❌ Redeem failed: ${market.conditionId}`, err.message);
        }
      }
    }

  } catch (err) {
    console.error('[REDEEM SERVICE ERROR]', err);
  }
}
}

// Export singleton instance
export const redeemService = new RedeemService();
