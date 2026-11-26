// Seeds the DeskFund on BNB Smart Chain testnet (chain 97) for the demo:
//   - loads or generates 3 depositor test keys in contracts/.depositors.json (gitignored, test keys only);
//   - the desk tops each depositor up to 0.003 tBNB and mints the tUSD it needs;
//   - depositors deposit 5, 3 and 2 tUSD (10 tUSD total); a depositor that already holds shares is skipped;
//   - the desk pays one 0.1 tUSD evaluation fee each for momentum, rwa and event (skipped if fees were
//     already paid; pass --force-fees to pay them again);
//   - prints fundState and every tx link.
// Needs deployments/bscTestnet-fund.json from `npm run deploy:fund`. Testnet only.
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toBytes,
  type Hex,
  type PrivateKeyAccount,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
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
const chain = chainFor('bscTestnet', rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const walletFor = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpc) });
const deskWallet = walletFor(desk);

const FUND_FILE = root('../deployments/bscTestnet-fund.json');
if (!existsSync(FUND_FILE)) throw new Error('deployments/bscTestnet-fund.json missing; run npm run deploy:fund first');
const dep = JSON.parse(readFileSync(FUND_FILE, 'utf8'));
const fund = getAddress(dep.fund.address);
const token = getAddress(dep.token.address);

const art = (n: string) => JSON.parse(readFileSync(root(`../artifacts/contracts/${n}.sol/${n}.json`), 'utf8')).abi;
const fundAbi = art('DeskFund');
const tusdAbi = art('TestUSD');

const DECIMALS = 6;
const GAS_TOPUP = parseEther('0.003');
const DEPOSITS = ['5', '3', '2'].map((x) => parseUnits(x, DECIMALS));
const FEE = parseUnits('0.1', DECIMALS);
const AGENTS = ['momentum', 'rwa', 'event'];
const forceFees = process.argv.includes('--force-fees');

const chainId = await pub.getChainId();
if (chainId !== 97) throw new Error(`RPC is on chain ${chainId}; this script runs on BNB Smart Chain testnet (97) only`);

// ---------- depositor keys ----------
const KEYS_FILE = root('../.depositors.json');
type Saved = { address: Hex; privateKey: Hex };
let saved: Saved[] = existsSync(KEYS_FILE) ? JSON.parse(readFileSync(KEYS_FILE, 'utf8')).depositors : [];
if (saved.length < 3) {
  while (saved.length < 3) {
    const pk = generatePrivateKey();
    saved.push({ address: privateKeyToAccount(pk).address, privateKey: pk });
  }
  writeFileSync(
    KEYS_FILE,
    JSON.stringify({ note: 'Throwaway BNB testnet depositor keys for the DeskFund demo. Never fund with real assets.', depositors: saved }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(`wrote ${saved.length} depositor keys to contracts/.depositors.json`);
}
const depositors = saved.slice(0, 3).map((s) => privateKeyToAccount(s.privateKey));

// ---------- helpers ----------
const links: string[] = [];
async function wait(label: string, hash: Hex) {
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${net.explorer}/tx/${hash}`);
  const line = `${label}: ${net.explorer}/tx/${hash}`;
  links.push(line);
  console.log(line);
  return rc;
}
const tusdBal = (a: Hex) => pub.readContract({ address: token, abi: tusdAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
const shares = (a: Hex) => pub.readContract({ address: fund, abi: fundAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
const fmt = (x: bigint) => formatUnits(x, DECIMALS);

// ---------- preflight ----------
const tusdOwner = getAddress((await pub.readContract({ address: token, abi: tusdAbi, functionName: 'owner' })) as Hex);
if (tusdOwner !== desk.address) throw new Error(`TestUSD owner is ${tusdOwner}, not the desk ${desk.address}; cannot mint`);
const roundActive = (await pub.readContract({ address: fund, abi: fundAbi, functionName: 'roundActive' })) as boolean;
if (roundActive) throw new Error('DeskFund has a round active; deposits are blocked until it closes');
const deskBnb = await pub.getBalance({ address: desk.address });
console.log(`desk ${desk.address}: ${formatEther(deskBnb)} tBNB`);
console.log(`DeskFund ${net.explorer}/address/${fund}`);

let deskNonce = await pub.getTransactionCount({ address: desk.address, blockTag: 'pending' });

// ---------- depositors ----------
for (const [i, acct] of depositors.entries()) {
  const amount = DEPOSITS[i];
  const tag = `depositor${i + 1} ${acct.address}`;
  const held = await shares(acct.address);
  if (held > 0n) {
    console.log(`${tag}: already holds ${formatUnits(held, 9)} CDS, skipping`);
    continue;
  }
  const bnb = await pub.getBalance({ address: acct.address });
  if (bnb < GAS_TOPUP) {
    await wait(`${tag} gas top-up`, await deskWallet.sendTransaction({ to: acct.address, value: GAS_TOPUP - bnb, nonce: deskNonce++ }));
  }
  const have = await tusdBal(acct.address);
  if (have < amount) {
    await wait(
      `${tag} mint ${fmt(amount - have)} tUSD`,
      await deskWallet.writeContract({ address: token, abi: tusdAbi, functionName: 'mint', args: [acct.address, amount - have], nonce: deskNonce++ }),
    );
  }
  const w = walletFor(acct);
  await wait(`${tag} approve`, await w.writeContract({ address: token, abi: tusdAbi, functionName: 'approve', args: [fund, amount] }));
  await wait(`${tag} deposit ${fmt(amount)} tUSD`, await w.writeContract({ address: fund, abi: fundAbi, functionName: 'deposit', args: [amount, acct.address] }));
}

// ---------- evaluation fees ----------
const [reserve0, fees0] = await Promise.all([
  pub.readContract({ address: fund, abi: fundAbi, functionName: 'reserve' }) as Promise<bigint>,
  pub.readContract({ address: fund, abi: fundAbi, functionName: 'protocolFees' }) as Promise<bigint>,
]);
if (reserve0 + fees0 > 0n && !forceFees) {
  console.log('evaluation fees already paid (reserve or protocolFees > 0), skipping; pass --force-fees to pay again');
} else {
  const total = FEE * BigInt(AGENTS.length);
  const have = await tusdBal(desk.address);
  if (have < total) {
    await wait(
      `desk mint ${fmt(total - have)} tUSD`,
      await deskWallet.writeContract({ address: token, abi: tusdAbi, functionName: 'mint', args: [desk.address, total - have], nonce: deskNonce++ }),
    );
  }
  await wait('desk approve fees', await deskWallet.writeContract({ address: token, abi: tusdAbi, functionName: 'approve', args: [fund, total], nonce: deskNonce++ }));
  for (const agent of AGENTS) {
    await wait(
      `evaluation fee ${agent} ${fmt(FEE)} tUSD`,
      await deskWallet.writeContract({ address: fund, abi: fundAbi, functionName: 'payEvaluationFee', args: [keccak256(toBytes(agent)), FEE], nonce: deskNonce++ }),
    );
  }
}

// ---------- report ----------
const [totalAssets, totalSupply, reserve, protocolFees, active, roundPot, activeRoundId] = (await pub.readContract({
  address: fund,
  abi: fundAbi,
  functionName: 'fundState',
})) as readonly [bigint, bigint, bigint, bigint, boolean, bigint, bigint];
console.log('\nfundState');
console.log(`  totalAssets   ${fmt(totalAssets)} tUSD (depositors)`);
console.log(`  totalSupply   ${formatUnits(totalSupply, 9)} CDS`);
console.log(`  reserve       ${fmt(reserve)} tUSD`);
console.log(`  protocolFees  ${fmt(protocolFees)} tUSD`);
console.log(`  roundActive   ${active}  roundPot ${fmt(roundPot)}  activeRoundId ${activeRoundId}`);
for (const [i, acct] of depositors.entries()) console.log(`  depositor${i + 1} ${acct.address}: ${formatUnits(await shares(acct.address), 9)} CDS`);
console.log(links.length ? `\n${links.length} transactions:\n${links.join('\n')}` : '\nno transactions sent (already seeded)');
