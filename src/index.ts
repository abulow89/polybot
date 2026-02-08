import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor from './services/tradeExecutor';
import tradeMonitor from './services/tradeMonitor';
import test from './test/test';
// Add this import at the top
import { redeemService } from './services/redeemService';

process.on("unhandledRejection", (reason, promise) => {
  console.error("🚨 UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("🚨 UNCAUGHT EXCEPTION:", error);
});

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;

export const main = async () => {
    await connectDB();
    console.log(`Target User Wallet addresss is: ${USER_ADDRESS}`);  // 🔹 FIXED: Was console.log`
    console.log(`My Wallet addresss is: ${PROXY_WALLET}`);  // 🔹 FIXED: Was console.log`
    
    const clobClient = await createClobClient();
    
    // 🔹 NEW: Start redemption service
    console.log('Starting redemption service...');
    redeemService.start();
    
    tradeMonitor();  //Monitor target user's transactions
    tradeExecutor(clobClient);  //Execute transactions on your wallet
    // test(clobClient);
};

// 🔹 NEW: Graceful shutdown handlers
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Stopping services...');
  redeemService.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Stopping services...');
  redeemService.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error("🚨 FATAL ERROR IN MAIN:", err);
});
