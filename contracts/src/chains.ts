import { defineChain } from 'viem';

export const NETWORKS = {
  bscTestnet: { chainId: 97, rpcEnv: 'BSC_TESTNET_RPC', explorer: 'https://testnet.bscscan.com', defaultRpc: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545' },
  bsc: { chainId: 56, rpcEnv: 'BSC_MAINNET_RPC', explorer: 'https://bscscan.com', defaultRpc: 'https://bsc-dataseed.bnbchain.org' },
} as const;
export type NetworkName = keyof typeof NETWORKS;

export function chainFor(name: NetworkName, rpc: string) {
  const n = NETWORKS[name];
  return defineChain({
    id: n.chainId,
    name: name === 'bsc' ? 'BNB Smart Chain' : 'BNB Smart Chain Testnet',
    nativeCurrency: { name: 'BNB', symbol: name === 'bsc' ? 'BNB' : 'tBNB', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}
