import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DataProvider, EventRisk, Instrument, Liquidity, MarketSnapshot, PriceMark } from '../../../shared/src/types.js';
import { ATLAS_TESTNET_FEEDS, AtlasReader, atlasMaxAgeSec, markAgreement, resolveAtlasConfig, type AtlasConfig } from './atlas.js';
import { assessDivergence, findFreshRanking, mapRanking, topByDivergence } from './divergence.js';
import { mapProbabilityResponse } from './cournot-map.js';
import { CmcClient, CmcSource } from './cmc.js';
import { CournotBudgetError, COURNOT_PROOF_DIR, assessClaim, findFreshProof } from './cournot.js';
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
  { claim: 'Bitcoin price below $50,000 at any time before 2027-01-01 05:00 UTC', marketId: '1342', polarity: 'adverse' },
  { claim: 'Ethereum price above $3,000 at any time before 2027-01-01 05:00 UTC', marketId: '1511', polarity: 'favorable' },
];

const num = (v: string | undefined): number | undefined => (Number(v) > 0 ? Number(v) : undefined);

/**
 * Cournot cache windows. COURNOT_ASSESS_TTL_MS (default 15 min) and COURNOT_RANKING_TTL_MS (default 30 min) say how
 * old a proof may be before a refresh is attempted. COURNOT_CACHE_TTL_MS is the maximum age at which an old proof is
 * still served when no refresh is possible (default 24 h, never below the refresh TTLs).
 */
export function cournotWindows(env: Record<string, string | undefined>): { assessTtl: number; rankingTtl: number; maxStale: number } {
  const assessTtl = num(env.COURNOT_ASSESS_TTL_MS) ?? 15 * 60_000;
  const rankingTtl = num(env.COURNOT_RANKING_TTL_MS) ?? 30 * 60_000;
  const maxStale = Math.max(num(env.COURNOT_CACHE_TTL_MS) ?? 24 * 3600_000, assessTtl, rankingTtl);
  return { assessTtl, rankingTtl, maxStale };
}

export interface LiveProviderOpts {
  /** Max abs(cmc - atlas) in bps for agreement both. Default 50. */
  priceToleranceBps?: number;
  instruments?: Instrument[];
  claims?: ClaimConfig[];
  /** Defaults to process.env after loading the repo-root .env. */
  env?: Record<string, string | undefined>;
  /** Override proof directory (tests). */
  proofDir?: string;
  /** Classified ranking rows to add to eventRisk (largest absolute divergence first). Default 5, 0 disables. */
  rankingRows?: number;
  /** Receives warnings (a failed Atlas read, a claim with no proof and no call budget, ...). */
  onWarn?: (message: string) => void;
}

export function createLiveProvider(opts: LiveProviderOpts = {}): DataProvider & { cmc: CmcSource; atlas?: AtlasReader; eventRisks(): Promise<EventRisk[]> } {
  loadEnv();
  const env = opts.env ?? process.env;
  const instruments = opts.instruments ?? INSTRUMENTS;
  const claims = opts.claims ?? DEFAULT_CLAIMS;
  const warn = opts.onWarn ?? ((m: string) => console.warn(`[data] ${m}`));
  const { assessTtl, rankingTtl, maxStale } = cournotWindows(env);
  const proofDir = opts.proofDir ?? COURNOT_PROOF_DIR;

  const cmc = new CmcSource(new CmcClient({ apiKey: env.CMC_API_KEY }));
  let atlasCfg: AtlasConfig | undefined;
  try {
    atlasCfg = resolveAtlasConfig(instruments, env);
  } catch (e) {
    warn(`ATLAS_FEEDS is invalid: ${(e as Error).message}`);
  }
  const mainAtlas = atlasCfg ? new AtlasReader(atlasCfg) : undefined;
  // Atlas feeds that exist only on BNB Smart Chain testnet (set up by Atlas for the hackathon).
  const testFeeds = Object.fromEntries(Object.entries(ATLAS_TESTNET_FEEDS).filter(([s]) => instruments.some((i) => i.symbol === s) && !mainAtlas?.has(s)));
  const testAtlas = Object.keys(testFeeds).length
    ? new AtlasReader({ chainId: 97, rpc: env.BSC_TESTNET_RPC || 'https://bsc-testnet-rpc.publicnode.com', feeds: testFeeds })
    : undefined;
  const atlas: AtlasReader | undefined = mainAtlas || testAtlas
    ? ({
        get lastErrors() { return { ...(testAtlas?.lastErrors ?? {}), ...(mainAtlas?.lastErrors ?? {}) }; },
        has: (s: string) => !!(mainAtlas?.has(s) || testAtlas?.has(s)),
        read: (s: string) => (mainAtlas?.has(s) ? mainAtlas.read(s) : testAtlas!.read(s)),
      } as unknown as AtlasReader)
    : undefined;
  const maxAge = atlasMaxAgeSec(env);
  const warned = new Set<string>();
  const warnOnce = (m: string) => {
    if (!warned.has(m)) {
      warned.add(m);
      warn(m);
    }
  };

  // ---- Cournot: serve the newest proof, refresh in the background, never throw into the snapshot ----
  const ownLive = new Set<number>(); // fetchedAt of proofs this process fetched live
  const inflight = new Map<string, Promise<void>>();
  const startRefresh = (key: string, run: () => Promise<number | undefined>, label: string) => {
    if (inflight.has(key)) return;
    const p = run()
      .then((at) => {
        if (at !== undefined) ownLive.add(at);
      })
      .catch((e) => {
        warnOnce(e instanceof CournotBudgetError ? `Cournot: ${label} refresh skipped (${(e as Error).message}); serving the saved proof` : `Cournot: ${label} refresh failed (${(e as Error).message}); serving the saved proof`);
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  };

  async function eventRisks(): Promise<EventRisk[]> {
    const out: EventRisk[] = [];
    const readClaim = (c: ClaimConfig): EventRisk | undefined => {
      const hit = findFreshProof(c.claim, proofDir, maxStale, Date.now());
      return hit
        ? mapProbabilityResponse({ claim: c.claim, marketId: c.marketId, polarity: c.polarity, body: hit.proof.rawResponse, requestId: hit.proof.requestId, fetchedAt: hit.proof.fetchedAt, live: ownLive.has(hit.proof.fetchedAt) })
        : undefined;
    };
    for (const c of claims) {
      let risk = readClaim(c);
      if (!risk || Date.now() - risk.fetchedAt > assessTtl) {
        startRefresh(`a:${c.marketId}`, async () => (await assessClaim(c.claim, { marketId: c.marketId, polarity: c.polarity, ttlMs: assessTtl, proofDir })).fetchedAt, `assessment ${c.marketId}`);
        if (!risk && inflight.has(`a:${c.marketId}`)) {
          await inflight.get(`a:${c.marketId}`);
          risk = readClaim(c);
        }
      }
      if (risk) out.push(risk);
      else warnOnce(`Cournot: no proof for "${c.claim}"; skipping this claim`);
    }
    if (opts.rankingRows !== 0) {
      const readRanking = (): EventRisk[] | undefined => {
        const hit = findFreshRanking(proofDir, maxStale, Date.now());
        return hit ? mapRanking(hit.proof.rawResponse, hit.proof.fetchedAt, ownLive.has(hit.proof.fetchedAt)).classified : undefined;
      };
      let rows = readRanking();
      const hit = findFreshRanking(proofDir, maxStale, Date.now());
      if (!hit || Date.now() - hit.proof.fetchedAt > rankingTtl) {
        startRefresh('ranking', async () => {
          await assessDivergence({ ttlMs: rankingTtl, proofDir });
          return findFreshRanking(proofDir, rankingTtl, Date.now())?.proof.fetchedAt;
        }, 'divergence ranking');
        if (!rows && inflight.has('ranking')) {
          await inflight.get('ranking');
          rows = readRanking();
        }
      }
      if (rows) out.push(...topByDivergence(rows, opts.rankingRows ?? 5));
    }
    return out;
  }

  return {
    cmc,
    atlas,
    eventRisks,
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
