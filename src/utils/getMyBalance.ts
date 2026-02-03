import { ethers } from 'ethers';
import { ENV } from '../config/env';

const RPC_URL1 = ENV.RPC_URL1;
const RPC_URL2 = ENV.RPC_URL2;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const rpcProvider = new ethers.providers.FallbackProvider(
    [
        {
            provider: new ethers.providers.JsonRpcProvider(RPC_URL1),
            priority: 1,
            stallTimeout: 700,
            weight: 2
        },
        {
            provider: new ethers.providers.JsonRpcProvider(RPC_URL2),
            priority: 2,
            stallTimeout: 700,
            weight: 1
        }
    ],
    1
);

const getMyBalance = async (address: string): Promise<number> => {
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, rpcProvider);
    const balance_usdc = await usdcContract.balanceOf(address);
    const balance_usdc_real = ethers.utils.formatUnits(balance_usdc, 6);
    return parseFloat(balance_usdc_real);
};

export default getMyBalance;
