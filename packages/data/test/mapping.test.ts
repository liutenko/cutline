import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapQuotes, mapDexToken, mapFearGreed, liquidityFromDex } from '../src/cmc.js';
import { computeAgreement, scaleAnswer, parseAtlasConfig, resolveAtlasConfig } from '../src/atlas.js';
import { mapProbabilityResponse } from '../src/cournot-map.js';
import { assessClaim, CournotBudgetError, findFreshProof } from '../src/cournot.js';
import { createReplayProvider, recordSnapshot } from '../src/provider.js';
import { INSTRUMENTS } from '../src/instruments.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('mapQuotes reads v3 array rows', () => {
  const rows = mapQuotes(fx('cmc-quotes.json'));
  const bnb = rows.find((r) => r.cmcId === 1839)!;
  assert.equal(bnb.symbol, 'BNB');
  assert.ok(bnb.price > 100);
  assert.equal(typeof bnb.pctChange1h, 'number');
  assert.ok(bnb.ts > 1.7e12);
});

test('mapDexToken gives liquidity, 24h volume and top pool', () => {
  const info = mapDexToken(fx('cmc-dex-token.json'))!;
  assert.ok(info.liquidityUsd > 400_000 && info.liquidityUsd < 450_000);
  assert.ok(Math.abs(info.volume24hUsd - 64518.95) < 1);
  assert.equal(info.topPool?.exchange, 'PancakeSwap v3 (BSC)');
  assert.equal(info.topPool?.pair, 'XAUM/USDT');
  assert.match(liquidityFromDex('XAUM', info, 1, 'pro').source, /CoinMarketCap DEX API/);
});

test('mapFearGreed', () => assert.equal(mapFearGreed({ data: { value: 10 } }), 10));

test('agreement logic', () => {
  assert.deepEqual(computeAgreement(100, undefined, 50), { agreement: 'single' });
  assert.equal(computeAgreement(100, 100.4, 50).agreement, 'both');
  assert.equal(computeAgreement(100, 100.6, 50).agreement, 'disagree');
  assert.ok(Math.abs(computeAgreement(100, 99, 50).deviationBps! - 100) < 1e-9);
});

test('scaleAnswer handles 18 decimals', () => {
  assert.ok(Math.abs(scaleAnswer(554661911485819577750n, 18)! - 554.6619114858196) < 1e-9);
  assert.equal(scaleAnswer(0n, 18), undefined);
});

test('atlas config: env JSON wins, else instrument feeds on chain 56', () => {
  const c = parseAtlasConfig('{"chainId":97,"rpc":"http://x","feeds":{"BNB":"0x01"}}')!;
  assert.equal(c.chainId, 97);
  assert.equal(resolveAtlasConfig(INSTRUMENTS, { ATLAS_FEEDS: JSON.stringify(c) })!.rpc, 'http://x');
  const d = resolveAtlasConfig(INSTRUMENTS, {})!;
  assert.equal(d.chainId, 56);
  assert.ok(d.feeds!.BNB);
  assert.equal(d.feeds!.XAUT, undefined);
});

test('cournot mapping is faithful to the saved real response', () => {
  const proof = fx('cournot-probability-1341.json');
  const r = mapProbabilityResponse({ claim: proof.claim, marketId: '1341', polarity: 'adverse', body: proof.rawResponse, fetchedAt: proof.fetchedAt, live: false });
  assert.equal(r.cournotProbability, 0.4862);
  assert.equal(r.venuePrice, 0.4862);
  assert.equal(r.divergence, 0);
  assert.equal(r.sources.length, 5);
  assert.equal(r.sources[0].title, 'polymarket');
  assert.match(r.sources[0].url!, /^https:\/\/polymarket\.com\/market\//);
  assert.equal(r.cournotExplanation, undefined);
  assert.equal(r.requestId, undefined);
  assert.equal(r.venue, 'polymarket, kalshi');
});

test('assessClaim serves the proof cache (live:false) and refuses a live call with budget 0', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'proofs-'));
  const proof = fx('cournot-probability-1341.json');
  writeFileSync(path.join(dir, 'p.json'), JSON.stringify(proof));
  const opts = { marketId: '1341', polarity: 'adverse' as const, proofDir: dir, maxCalls: 0, now: () => proof.fetchedAt + 60_000 };
  const r = await assessClaim(proof.claim, opts);
  assert.equal(r.live, false);
  assert.ok(findFreshProof(proof.claim, dir, 1000, proof.fetchedAt + 60_000) === undefined);
  await assert.rejects(assessClaim(proof.claim, { ...opts, now: () => proof.fetchedAt + 3 * 3600_000 }), CournotBudgetError);
});

test('record and replay loop with mode replay', async () => {
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'x.jsonl');
  for (const ts of [1, 2]) recordSnapshot({ ts, marks: {}, liquidity: {}, eventRisk: [], mode: 'live' }, f);
  const p = createReplayProvider(f);
  const seq = [];
  for (let i = 0; i < 3; i++) seq.push(await p.snapshot());
  assert.deepEqual(seq.map((s) => s.ts), [1, 2, 1]);
  assert.ok(seq.every((s) => s.mode === 'replay'));
});

test('instruments: 8 entries with cmcId and BNB Chain addresses, one thin', () => {
  assert.equal(INSTRUMENTS.length, 8);
  assert.equal(INSTRUMENTS.filter((i) => i.kind === 'thin').length, 1);
  assert.ok(INSTRUMENTS.every((i) => i.cmcId > 0 && /^0x[0-9a-f]{40}$/.test(i.bscAddress!)));
});

import { markAgreement } from '../src/atlas.js';
import { describeRecording } from '../src/provider.js';
import { mapRanking, topByDivergence, extractRows } from '../src/divergence.js';
import { classifyPolarity } from '../src/polarity.js';

test('stale Atlas feed is single and never disagree, values kept', () => {
  const now = 10_000_000;
  const fresh = markAgreement(100, { price: 100.1, ts: now - 60_000 }, 50, now, 3600);
  assert.equal(fresh.agreement, 'both');
  assert.equal(fresh.atlasStale, undefined);
  const stale = markAgreement(100, { price: 90, ts: now - 7200_000 }, 50, now, 3600);
  assert.equal(stale.agreement, 'single');
  assert.equal(stale.atlasStale, true);
  assert.ok(Math.abs(stale.deviationBps! - 1000) < 1e-6);
  assert.equal(markAgreement(100, { price: 90, ts: now - 60_000 }, 50, now, 3600).agreement, 'disagree');
});

test('describeRecording', () => {
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'rec2-')), 'x.jsonl');
  for (const ts of [5, 9, 7]) recordSnapshot({ ts, marks: {}, liquidity: {}, eventRisk: [], mode: 'live' }, f);
  assert.deepEqual(describeRecording(f), { from: 5, to: 7, count: 3 });
});

test('polarity rules: classify only clear cases', () => {
  assert.equal(classifyPolarity('Will Bitcoin exceed $85,000 before Jan 1, 2027?')?.polarity, 'favorable');
  assert.equal(classifyPolarity('Will Ethereum dip to $1,250 by December 31, 2026?')?.polarity, 'adverse');
  assert.equal(classifyPolarity('Will the Federal Reserve Hike rates by 25bps at their December 2026 meeting?')?.polarity, 'adverse');
  assert.equal(classifyPolarity('Will the Federal Reserve Hike rates by 0bps at their December 2026 meeting?'), undefined);
  assert.equal(classifyPolarity('Will Opensea FDV be above $1999999999.99 at 10:00 AM on Jan 1, 2027?'), undefined);
  assert.equal(classifyPolarity('Will Cincinnati Bengals win the 2027 NFL AFC Championship?'), undefined);
});

test('ranking rows map to EventRisk from the saved real response', () => {
  const proof = fx('cournot-divergence.json');
  assert.equal(extractRows(proof.rawResponse).length, 100);
  const { all, classified } = mapRanking(proof.rawResponse, proof.fetchedAt, false);
  assert.equal(all, 100);
  assert.ok(classified.length > 0 && classified.length < 100);
  assert.ok(classified.every((e) => e.origin === 'ranking' && e.sources.length === 0 && e.live === false));
  const top = topByDivergence(classified, 5);
  assert.equal(top.length, 5);
  assert.ok(Math.abs(top[0].divergence!) >= Math.abs(top[4].divergence!));
  assert.equal(top[0].divergence, top[0].cournotProbability - top[0].venuePrice!);
});
