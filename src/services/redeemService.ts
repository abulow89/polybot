import { redeemAllResolvedMarkets } from '../utils/redeemWinnings';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const UserActivity = getUserActivityModel(ENV.USER_ADDRESS);
const REDEEM_INTERVAL = 1 * 60 * 1000; // 1 minutes in milliseconds

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

      // Get all unique condition IDs from your trade history
      const trades = await UserActivity.find({ bot: true }).distinct('conditionId');
      
      if (!trades || trades.length === 0) {
        console.log('[REDEEM SERVICE] No markets to check');
        return;
      }

      console.log(`[REDEEM SERVICE] Found ${trades.length} markets to check`);

      // Attempt to redeem all markets
      await redeemAllResolvedMarkets(trades);

      console.log('[REDEEM SERVICE] Check complete');
    } catch (err) {
      console.error('[REDEEM SERVICE ERROR]', err);
    }
  }
}

// Export singleton instance
export const redeemService = new RedeemService();
