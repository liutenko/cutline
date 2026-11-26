// Records a live MarketSnapshot every 60s into data/recordings/<UTC date>.jsonl. Run: npm run record
import path from 'node:path';
import { RECORDINGS_DIR } from '../src/env.js';
import { createLiveProvider, recordSnapshot } from '../src/provider.js';

const intervalMs = Number(process.env.RECORD_INTERVAL_MS ?? 60_000);
const tolerance = Number(process.env.PRICE_TOLERANCE_BPS ?? 50);
const provider = createLiveProvider({ priceToleranceBps: tolerance });
let stop = false;
let lastCreditLog = Date.now();
process.on('SIGINT', () => (stop = true));
process.on('SIGTERM', () => (stop = true));

console.log(`[record] every ${intervalMs / 1000}s, CoinMarketCap mode: ${provider.cmc.client.mode}`);
while (!stop) {
  const started = Date.now();
  try {
    const snap = await provider.snapshot();
    const file = path.join(RECORDINGS_DIR, `${new Date(snap.ts).toISOString().slice(0, 10)}.jsonl`);
    recordSnapshot(snap, file);
    console.log(`[record] ${new Date(snap.ts).toISOString()} marks=${Object.keys(snap.marks).length} liq=${Object.keys(snap.liquidity).length} events=${snap.eventRisk.length} fg=${snap.fearGreed ?? 'n/a'} -> ${path.basename(file)}`);
  } catch (e) {
    console.error(`[record] snapshot failed: ${(e as Error).message}`);
  }
  if (Date.now() - lastCreditLog >= 30 * 60_000) {
    lastCreditLog = Date.now();
    console.log(`[record] CoinMarketCap usage so far in this run: ${provider.cmc.client.calls} calls, ${provider.cmc.client.credits} credits`);
  }
  const wait = Math.max(1000, intervalMs - (Date.now() - started));
  const end = Date.now() + wait;
  while (!stop && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
}
console.log('[record] stopped');
