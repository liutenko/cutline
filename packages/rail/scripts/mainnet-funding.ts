// One-time funding and withdrawal of a Yellow account on BNB Chain (chain 56). REAL FUNDS.
// Run only by the human owner. See scripts/fund-mainnet.md for the exact sequence.
//
//   npx tsx scripts/mainnet-funding.ts status   [--as desk]                    read-only
//   npx tsx scripts/mainnet-funding.ts deposit  <amount> --yes-real-funds       approve + deposit + checkpoint
//   npx tsx scripts/mainnet-funding.ts withdraw <amount> --yes-real-funds [--as momentum]
//
// Keys: uses <NAME>_MAINNET (for example DESK_KEY_MAINNET) when set, else <NAME> (DESK_KEY).
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import { Client, createSigners, withBlockchainRPC } from '@yellow-org/sdk';
import { createPublicClient, formatEther, http } from 'viem';
import { KEY_ENV, networkConfig } from '../src/yellow.js';
import type { Hex } from '../../../shared/src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env'), quiet: true });

const CHAIN = 56n;
const args = process.argv.slice(2);
const cmd = args[0];
const asIdx = args.indexOf('--as');
const who = asIdx >= 0 ? args[asIdx + 1]! : 'desk';
const assetIdx = args.indexOf('--asset');
const asset = assetIdx >= 0 ? args[assetIdx + 1]! : 'usdt';
const cfg = networkConfig('yellow-mainnet', process.env);
const bscscan = (h: string) => `https://bscscan.com/tx/${h}`;

function key(): Hex {
  const base = KEY_ENV[who];
  if (!base) throw new Error(`unknown participant "${who}"`);
  const v = process.env[`${base}_MAINNET`] || process.env[base];
  if (!v) throw new Error(`missing ${base}_MAINNET or ${base}`);
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex;
}

async function main() {
  if (!['status', 'deposit', 'withdraw'].includes(cmd ?? '')) {
    console.log('usage: status | deposit <amount> --yes-real-funds | withdraw <amount> --yes-real-funds  [--as <id>] [--asset usdt|usdc]');
    process.exit(2);
  }
  if (!cfg.rpcUrl) throw new Error('missing BSC_MAINNET_RPC');
  const s = createSigners(key());
  const wallet = s.stateSigner.getAddress();
  const client = await Client.create(cfg.wsUrl, s.stateSigner, s.txSigner, withBlockchainRPC(CHAIN, cfg.rpcUrl));
  console.log(`${who} ${wallet} on ${cfg.wsUrl}, chain ${CHAIN}, asset ${asset}`);

  const pc = createPublicClient({ transport: http(cfg.rpcUrl) });
  const bnb = await pc.getBalance({ address: wallet });
  const onchain = await client.getOnChainBalance(CHAIN, asset, wallet);
  const node = await client.getBalances(wallet);
  console.log(`BNB for gas: ${formatEther(bnb)}`);
  console.log(`${asset} in wallet on BNB Chain: ${onchain.toFixed()}`);
  console.log(`balances at Yellow: ${JSON.stringify(node.map((b) => ({ asset: b.asset, balance: b.balance.toFixed(), enforced: b.enforced.toFixed() })))}`);
  if (cmd === 'status') return client.close();

  if (!args.includes('--yes-real-funds')) throw new Error('refusing to move real funds without --yes-real-funds');
  const amount = new Decimal(args[1] ?? 'NaN');
  if (!amount.isFinite() || amount.lte(0)) throw new Error('amount must be a positive number');

  if (cmd === 'deposit') {
    await client.setHomeBlockchain(asset, CHAIN);
    const approveTx = await client.approveToken(CHAIN, asset, amount);
    console.log(`approve tx: ${approveTx} ${bscscan(approveTx)}`);
    await client.deposit(CHAIN, asset, amount); // off-chain: node co-signs the deposit state
    const tx = await client.checkpoint(asset); // on-chain: ChannelHub pulls the tokens
    console.log(`deposit checkpoint tx: ${tx} ${bscscan(tx)}`);
    const entry = await client.waitForCheckpoint(asset, tx, { chainId: CHAIN, timeoutMs: 180_000 });
    console.log(`credited at Yellow: ${entry.balance.toFixed()} ${asset} (enforced ${entry.enforced.toFixed()})`);
  } else {
    await client.withdraw(CHAIN, asset, amount); // off-chain: node co-signs the withdrawal state
    const tx = await client.checkpoint(asset); // on-chain: ChannelHub releases the tokens to the wallet
    console.log(`withdraw checkpoint tx: ${tx} ${bscscan(tx)}`);
  }
  await client.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
