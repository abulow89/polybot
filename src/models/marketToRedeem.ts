import mongoose from 'mongoose';

const MarketToRedeemSchema = new mongoose.Schema({
  conditionId: { type: String, required: true, unique: true },
  addedAt: { type: Date, default: Date.now },
  redeemed: { type: Boolean, default: false },
  redeemedAt: { type: Date }
});

export const MarketToRedeem = mongoose.model('MarketToRedeem', MarketToRedeemSchema);
