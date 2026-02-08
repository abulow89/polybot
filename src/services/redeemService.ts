import { redeemAllResolvedMarkets } from '../utils/redeemWinnings';
import { MarketToRedeem } from '../models/marketToRedeem';
import { ENV } from '../config/env';

const REDEEM_INTERVAL = 30 * 1000; // 30 seconds

export class RedeemService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  start() {
    if (this.isRunning) {
      console.log('[REDEEM SERVICE] Already running');
      return;
    }

    console.log('[REDEEM SERVICE] Starting... Will check every 30 seconds');
    this.isRunning = true;

    this.checkAndRedeem();

    this.intervalId = setInterval(() => {
      this.checkAndRedeem();
    }, REDEEM_INTERVAL);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log('[REDEEM SERVICE] Stopped');
    }
  }

  private async checkAndRedeem() {
    try {
      console.log('[REDEEM SERVICE] Checking for resolved markets...');

      const markets = await MarketToRedeem.find({ redeemed: false }).lean();

      if (!markets || markets.length === 0) {
        console.log('[REDEEM SERVICE] No markets to redeem');
        return;
      }

      const conditionIds = markets.map((m: any) => m.conditionId);

      console.log(`[REDEEM SERVICE] Attempting redemption for ${conditionIds.length} markets`);

      // 🔥 Call correct function
      await redeemAllResolvedMarkets(conditionIds);

      // Mark all as redeemed (you can improve this later if needed)
      await MarketToRedeem.updateMany(
        { conditionId: { $in: conditionIds } },
        { redeemed: true, redeemedAt: new Date() }
      );

    } catch (err) {
      console.error('[REDEEM SERVICE ERROR]', err);
    }
  }
}

export const redeemService = new RedeemService();
