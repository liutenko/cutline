import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DataProvider, EventRisk, Instrument, Liquidity, MarketSnapshot, PriceMark } from '../../../shared/src/types.js';
import { AtlasReader, atlasMaxAgeSec, markAgreement, resolveAtlasConfig, type AtlasConfig } from './atlas.js';
import { assessDivergence, topByDivergence } from './divergence.js';
import { CmcClient, CmcSource } from './cmc.js';
import { CournotBudgetError, assessClaim, DEFAULT_TTL_MS } from './cournot.js';
import { loadEnv } from './env.js';
import { INSTRUMENTS } from './instruments.js';

export interface ClaimConfig {
  /** Exact claim text sent to Cournot (also the cache key). */
  claim: string;
  marketId: string;
  polarity: 'adverse' | 'favorable';
}

/** Claims the live provider assesses. Chosen from the free Cournot resolve step on 2026-11-26. */
export const DEFAULT_CLAIMS: ClaimConfig[] = [
  { claim: 'Bitcoin price below $55,000 at any time before 2027-01-01 05:00 UTC', marketId: '1341', polarity: 'adverse' },
];

export interface LiveProviderOpts {
  /** Max abs(cmc - atlas) in bps for agreement both. Default 50. */
  priceToleranceBps?: number;
  instruments?: Instrument[];
  claims?: ClaimConfig[];
  /** Defaults to process.env after loading the repo-root .env. */
  env?: Record<string, string | undefined>;
  /** Cournot proof cache TTL. Default env COURNOT_CACHE_TTL_MS, else 30 min. */
  cournotTtlMs?: number;
  /** Classified ranking rows to add to eventRisk (largest absolute divergence first). Default 5, 0 disables. */
  rankingRows?: number;
  /** Receives warnings (a failed Atlas read, a claim with no proof and no call budget, ...). */
  onWarn?: (message: string) => void;
}

export function createLiveProvider(opts: LiveProviderOpts = {}): DataProvider & { cmc: CmcSource; atlas?: AtlasReader } {
  loadEnv();
  const env = opts.env ?? process.env;
  const instruments = opts.instruments ?? INSTRUMENTS;
  const claims = opts.claims ?? DEFAULT_CLAIMS;
  const warn = opts.onWarn ?? ((m: string) => console.warn(`[data] ${m}`));
  const ttl = opts.cournotTtlMs ?? (Number(env.COURNOT_CACHE_TTL_MS) > 0 ? Number(env.COURNOT_CACHE_TTL_MS) : DEFAULT_TTL_MS);

  const cmc = new CmcSource(new CmcClient({ apiKey: env.CMC_API_KEY }));
  let atlasCfg: AtlasConfig | undefined;
  try {
    atlasCfg = resolveAtlasConfig(instruments, env);
  } catch (e) {
    warn(`ATLAS_FEEDS is invalid: ${(e as Error).message}`);
  }
  const atlas = atlasCfg ? new AtlasReader(atlasCfg) : undefined;
  const maxAge = atlasMaxAgeSec(env);
  const warned = new Set<string>();
  const warnOnce = (m: string) => {
    if (!warned.has(m)) {
      warned.add(m);
      warn(m);
    }
  };

  async function eventRisks(): Promise<EventRisk[]> {
    const out: EventRisk[] = [];
    for (const c of claims) {
      try {
        out.push(await assessClaim(c.claim, { marketId: c.marketId, polarity: c.polarity, ttlMs: ttl }));
      } catch (e) {
        warnOnce(e instanceof CournotBudgetError ? `Cournot: no fresh proof for "${c.claim}" and no live budget; skipping this claim` : `Cournot: ${(e as Error).message}`);
      }
    }
    if (opts.rankingRows !== 0) {
      try {
        out.push(...topByDivergence(await assessDivergence({ ttlMs: ttl }), opts.rankingRows ?? 5));
      } catch (e) {
        warnOnce(e instanceof CournotBudgetError ? 'Cournot: no fresh divergence ranking proof and no live budget; skipping ranking rows' : `Cournot ranking: ${(e as Error).message}`);
      }
    }
    return out;
  }

  return {
    cmc,
    atlas,
    instruments: () => instruments,
    async snapshot(): Promise<MarketSnapshot> {
      const [quotes, liquidity, fearGreed, eventRisk, atlasReads] = await Promise.all([
        cmc.quotes(instruments),
        cmc.liquidity(instruments),
        cmc.fearGreed(),
        eventRisks(),
        Promise.all(instruments.map((i) => (atlas?.has(i.symbol) ? atlas.read(i.symbol) : Promise.resolve(undefined)))),
      ]);
      const marks: Record<string, PriceMark> = {};
      instruments.forEach((inst, idx) => {
        const q = quotes.get(inst.cmcId);
        if (!q) return;
        const a = atlasReads[idx];
        if (atlas?.has(inst.symbol) && !a) warnOnce(`Atlas read failed for ${inst.symbol}: ${atlas.lastErrors[inst.symbol] ?? 'empty feed'}`);
        marks[inst.symbol] = {
          symbol: inst.symbol,
          cmcPrice: q.price,
          cmcTs: q.ts,
          ...(q.pctChange1h !== undefined ? { pctChange1h: q.pctChange1h } : {}),
          ...(q.pctChange24h !== undefined ? { pctChange24h: q.pctChange24h } : {}),
          ...(a ? { atlasPrice: a.price, atlasTs: a.ts } : {}),
          ...markAgreement(q.price, a, opts.priceToleranceBps ?? 50, Date.now(), maxAge),
        };
      });
      const liq: Record<string, Liquidity> = liquidity;
      return { ts: Date.now(), marks, liquidity: liq, eventRisk, ...(fearGreed !== undefined ? { fearGreed } : {}), mode: 'live' };
    },
  };
}

/** First and last snapshot time (ms) and frame count of a recording. */
export function describeRecording(file: string): { from: number; to: number; count: number } {
  const snaps = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as MarketSnapshot);
  if (!snaps.length) throw new Error(`Recording has no snapshots: ${file}`);
  return { from: snaps[0].ts, to: snaps[snaps.length - 1].ts, count: snaps.length };
}

/** Appends one snapshot as a JSON line. */
export function recordSnapshot(snapshot: MarketSnapshot, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(snapshot) + '\n');
}

export interface ReplayOpts {
  instruments?: Instrument[];
  /** First frame to return. Default 0. */
  startIndex?: number;
}

export interface ReplayProvider extends DataProvider {
  readonly frames: number;
  /** Timestamp (ms) of the first and last recorded snapshot, for the "Replay of live data recorded <time>" label. */
  readonly recordedFrom: number;
  readonly recordedTo: number;
  reset(): void;
}

/** Plays a JSONL recording, one snapshot per call, looping. Snapshots are returned with mode 'replay' and their recorded ts. */
export function createReplayProvider(file: string, opts: ReplayOpts = {}): ReplayProvider {
  const snaps: MarketSnapshot[] = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MarketSnapshot);
  if (!snaps.length) throw new Error(`Replay file has no snapshots: ${file}`);
  let i = opts.startIndex ?? 0;
  const instruments = opts.instruments ?? INSTRUMENTS;
  return {
    frames: snaps.length,
    recordedFrom: snaps[0].ts,
    recordedTo: snaps[snaps.length - 1].ts,
    reset() {
      i = opts.startIndex ?? 0;
    },
    instruments: () => instruments,
    async snapshot(): Promise<MarketSnapshot> {
      const s = snaps[i % snaps.length];
      i += 1;
      return { ...structuredClone(s), mode: 'replay' };
    },
  };
}
