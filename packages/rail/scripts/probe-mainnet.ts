// Read-only probe of a Yellow node: ping, getConfig, getAssets. No signing of state, no transactions.
// Uses a throwaway random key so no real key ever touches the production node.
// Usage: tsx scripts/probe-mainnet.ts [mainnet|sandbox]
import WebSocket from 'ws';
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket: unknown }).WebSocket = WebSocket;
}
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client, createSigners } from '@yellow-org/sdk';
import { generatePrivateKey } from 'viem/accounts';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env'), quiet: true });

const which = process.argv[2] === 'sandbox' ? 'sandbox' : 'mainnet';
const url =
  which === 'sandbox'
    ? process.env.YELLOW_WS_SANDBOX || 'wss://nitronode-sandbox.yellow.org/v1/ws'
    : process.env.YELLOW_WS_MAINNET || 'wss://nitronode.yellow.org/v1/ws';

const s = createSigners(generatePrivateKey());
const client = await Client.create(url, s.stateSigner, s.txSigner);
await client.ping();
console.log(`[${which}] ${url} ping ok`);
const cfg = await client.getConfig();
console.log(`node ${cfg.nodeAddress} version ${cfg.nodeVersion}`);
for (const b of cfg.blockchains) {
  console.log(`  chain ${b.id} ${b.name} channelHub=${b.channelHubAddress} confirmDelay=${b.confirmationDelaySecs}s`);
}
const assets = await client.getAssets();
for (const a of assets) {
  const toks = a.tokens.map((t) => `${t.blockchainId}:${t.address}(${t.decimals})`).join(' ');
  console.log(`  asset ${a.symbol} decimals=${a.decimals} suggestedChain=${a.suggestedBlockchainId} tokens=${toks}`);
}
await client.close();
process.exit(0);
