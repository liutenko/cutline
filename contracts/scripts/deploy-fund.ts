// Deploys the open vault to BNB Smart Chain testnet (chain 97) with DESK_KEY:
//   1. DeskFund(TestUSD, owner = desk, operator = desk)
//   2. a NEW DeskVault(TestUSD, desk = DeskFund, riskManager = RISK_KEY's address)
//   3. DeskFund.setVault(DeskVault)
// Reuses the TestUSD from deployments/bscTestnet-vault.json and writes deployments/bscTestnet-fund.json.
// The existing DeskVault in bscTestnet-vault.json is not touched. Testnet only.
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, type Hex } from 'viem';
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

const OUT = root('../deployments/bscTestnet-fund.json');
if (existsSync(OUT) && !process.argv.includes('--force')) {
  throw new Error(`${OUT} already exists. Re-run with --force to deploy a new DeskFund and overwrite it.`);
}

const vaultDeployment = JSON.parse(readFileSync(root('../deployments/bscTestnet-vault.json'), 'utf8'));
const testUSD = getAddress(vaultDeployment.token.address);

const chainId = await pub.getChainId();
if (chainId !== 97) throw new Error(`RPC is on chain ${chainId}; this script deploys to BNB Smart Chain testnet (97) only`);
if ((await pub.getCode({ address: testUSD })) === undefined) throw new Error(`no TestUSD contract at ${testUSD}`);
const bal = await pub.getBalance({ address: desk.address });
console.log(`desk ${desk.address}: ${formatEther(bal)} tBNB`);
console.log(`risk manager ${riskAddress}`);
console.log(`TestUSD ${testUSD}`);
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

const fundArt = art('DeskFund');
const vaultArt = art('DeskVault');
const r1 = await wait(
  'deployDeskFund',
  await wallet.deployContract({ abi: fundArt.abi, bytecode: fundArt.bytecode, args: [testUSD, desk.address, desk.address], nonce: nonce++ }),
);
const deskFund = getAddress(r1.contractAddress!);
const r2 = await wait(
  'deployDeskVault',
  await wallet.deployContract({ abi: vaultArt.abi, bytecode: vaultArt.bytecode, args: [testUSD, deskFund, riskAddress], nonce: nonce++ }),
);
const deskVault = getAddress(r2.contractAddress!);
await wait('setVault', await wallet.writeContract({ address: deskFund, abi: fundArt.abi, functionName: 'setVault', args: [deskVault], nonce: nonce++ }));

const linked = (await pub.readContract({ address: deskFund, abi: fundArt.abi, functionName: 'deskVault' })) as Hex;
if (getAddress(linked) !== deskVault) throw new Error(`setVault did not stick: fund points at ${linked}`);

mkdirSync(root('../deployments'), { recursive: true });
const tx = (h: Hex) => ({ hash: h, url: `${net.explorer}/tx/${h}` });
const out = {
  chainId,
  fund: { address: deskFund, txHash: txs.deployDeskFund, block: Number(r1.blockNumber), url: `${net.explorer}/address/${deskFund}`, symbol: 'CDS', decimals: 9 },
  vault: { address: deskVault, txHash: txs.deployDeskVault, block: Number(r2.blockNumber), url: `${net.explorer}/address/${deskVault}` },
  token: { address: testUSD, url: `${net.explorer}/address/${testUSD}`, symbol: 'tUSD', decimals: 6 },
  owner: desk.address,
  operator: desk.address,
  riskManager: riskAddress,
  txs: { deployDeskFund: tx(txs.deployDeskFund), deployDeskVault: tx(txs.deployDeskVault), setVault: tx(txs.setVault) },
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`DeskFund  ${net.explorer}/address/${deskFund}`);
console.log(`DeskVault ${net.explorer}/address/${deskVault} (desk = DeskFund)`);
console.log(`wrote deployments/bscTestnet-fund.json; spent ${formatEther(gas)} tBNB. Next: npm run seed:fund`);
