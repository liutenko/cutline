import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainFor, NETWORKS, type NetworkName } from '../src/chains.js';

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));
config({ path: root('../../.env') });

const network = (process.argv[2] ?? 'bscTestnet') as NetworkName;
const net = NETWORKS[network];
if (!net) throw new Error(`Unknown network "${network}". Use bscTestnet or bsc.`);
const rpc = process.env[net.rpcEnv]?.trim() || net.defaultRpc;
const key = process.env.DESK_KEY?.trim();
if (!key) throw new Error('DESK_KEY missing in repo-root .env');

const artifactRel = 'artifacts/contracts/Scorecard.sol/Scorecard.json';
const artifact = JSON.parse(readFileSync(root(`../${artifactRel}`), 'utf8'));
const chain = chainFor(network, rpc);
const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [account.address] });
const rc = await pub.waitForTransactionReceipt({ hash });
if (!rc.contractAddress) throw new Error(`Deploy failed, tx ${hash}`);

mkdirSync(root('../deployments'), { recursive: true });
writeFileSync(
  root(`../deployments/${network}.json`),
  JSON.stringify(
    { address: rc.contractAddress, chainId: net.chainId, block: Number(rc.blockNumber), txHash: hash, operator: account.address, abi: artifactRel },
    null,
    2,
  ) + '\n',
);
console.log(`Scorecard deployed on ${network}: ${rc.contractAddress}`);
console.log(`${net.explorer}/address/${rc.contractAddress}`);
console.log(`${net.explorer}/tx/${hash}`);
console.log(`Set SCORECARD_ADDRESS=${rc.contractAddress} in the repo-root .env`);
