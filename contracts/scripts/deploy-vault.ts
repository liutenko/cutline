// Deploys TestUSD and DeskVault to BNB Smart Chain testnet (chain 97) with DESK_KEY, mints 1,000 tUSD
// to the desk, approves the vault, and writes deployments/bscTestnet-vault.json. Testnet only.
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, http, maxUint256, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainFor, NETWORKS } from '../src/chains.js';

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));
config({ path: root('../../.env'), quiet: true });

const net = NETWORKS.bscTestnet;
const rpc = process.env[net.rpcEnv]?.trim() || net.defaultRpc;
const key = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} missing in repo-root .env`);
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex;
};
const desk = privateKeyToAccount(key('DESK_KEY'));
const riskAddress = privateKeyToAccount(key('RISK_KEY')).address;
const chain = chainFor('bscTestnet', rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: desk, chain, transport: http(rpc) });

const chainId = await pub.getChainId();
if (chainId !== 97) throw new Error(`RPC is on chain ${chainId}; this script deploys to BNB Smart Chain testnet (97) only`);
const bal = await pub.getBalance({ address: desk.address });
console.log(`desk ${desk.address}: ${formatEther(bal)} tBNB`);
if (bal < 10n ** 16n) throw new Error('desk has under 0.01 tBNB; top it up from a BNB testnet faucet first');

const art = (n: string) => JSON.parse(readFileSync(root(`../artifacts/contracts/${n}.sol/${n}.json`), 'utf8'));
let nonce = await pub.getTransactionCount({ address: desk.address, blockTag: 'pending' });
const txs: Record<string, Hex> = {};
let gas = 0n;
async function wait(label: string, hash: Hex) {
  txs[label] = hash;
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${net.explorer}/tx/${hash}`);
  gas += rc.gasUsed * rc.effectiveGasPrice;
  console.log(`${label}: ${net.explorer}/tx/${hash} (gas ${rc.gasUsed})`);
  return rc;
}

const tusdArt = art('TestUSD');
const vaultArt = art('DeskVault');
const r1 = await wait('deployTestUSD', await wallet.deployContract({ abi: tusdArt.abi, bytecode: tusdArt.bytecode, args: [desk.address], nonce: nonce++ }));
const testUSD = r1.contractAddress!;
await wait('mint', await wallet.writeContract({ address: testUSD, abi: tusdArt.abi, functionName: 'mint', args: [desk.address, parseUnits('1000', 6)], nonce: nonce++ }));
const r3 = await wait('deployDeskVault', await wallet.deployContract({ abi: vaultArt.abi, bytecode: vaultArt.bytecode, args: [testUSD, desk.address, riskAddress], nonce: nonce++ }));
const deskVault = r3.contractAddress!;
await wait('approve', await wallet.writeContract({ address: testUSD, abi: tusdArt.abi, functionName: 'approve', args: [deskVault, maxUint256], nonce: nonce++ }));

mkdirSync(root('../deployments'), { recursive: true });
const out = {
  chainId,
  vault: { address: deskVault, txHash: txs.deployDeskVault, block: Number(r3.blockNumber) },
  token: { address: testUSD, txHash: txs.deployTestUSD, block: Number(r1.blockNumber), symbol: 'tUSD', decimals: 6 },
  desk: desk.address,
  riskManager: riskAddress,
  mintTx: txs.mint,
  approveTx: txs.approve,
};
writeFileSync(root('../deployments/bscTestnet-vault.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`TestUSD   ${net.explorer}/address/${testUSD}`);
console.log(`DeskVault ${net.explorer}/address/${deskVault}`);
console.log(`spent ${formatEther(gas)} tBNB. Set VAULT_ADDRESS=${deskVault} and TEST_USD_ADDRESS=${testUSD} in the repo-root .env (optional; the rail falls back to deployments/bscTestnet-vault.json)`);
