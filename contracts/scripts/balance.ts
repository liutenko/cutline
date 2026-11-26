import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createPublicClient, formatEther, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainFor, NETWORKS } from '../src/chains.js';

config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
const rpc = process.env.BSC_TESTNET_RPC?.trim() || NETWORKS.bscTestnet.defaultRpc;
const k = process.env.DESK_KEY!.trim();
const a = privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex).address;
const pub = createPublicClient({ chain: chainFor('bscTestnet', rpc), transport: http(rpc) });
console.log(`${a} balance on BSC testnet: ${formatEther(await pub.getBalance({ address: a }))} tBNB`);
