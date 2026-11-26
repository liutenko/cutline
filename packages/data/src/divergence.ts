import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EventRisk } from '../../../shared/src/types.js';
import { COURNOT_CLIENT, COURNOT_PROOF_DIR, COURNOT_TEE, DEFAULT_TTL_MS, CournotCallError, clientCommit, maxCallsFromEnv, pickBilling, redactIp, reserveLiveCall } from './cournot.js';
import { classifyPolarity } from './polarity.js';

const execFileAsync = promisify(execFile);

export const DIVERGENCE_KIND = 'divergence-ranking';

export interface DivergenceOpts {
  /** Items to fetch in the single call (1..100). Default 100. */
  limit?: number;
  ttlMs?: number;
  maxCalls?: number;
  proofDir?: string;
  now?: () => number;
  apiKey?: string;
  clientPath?: string;
}

export interface RankingRow {
  rank?: number;
  title: string;
  source?: string;
  url?: string;
  cournot_price: number;
  market_price: number;
  deviation?: number;
  direction?: string;
  market_liquidity?: number;
}

export function extractRows(body: any): RankingRow[] {
  const items = body?.data?.divergence?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((r: any) => r && typeof r.title === 'string' && typeof r.cournot_price === 'number' && typeof r.market_price === 'number');
}

/** Maps ranking rows to EventRisk. Unclassifiable rows are dropped. Returns kept rows plus counts. */
export function mapRanking(body: any, fetchedAt: number, live: boolean): { all: number; classified: EventRisk[] } {
  const rows = extractRows(body);
  const classified: EventRisk[] = [];
  for (const r of rows) {
    const c = classifyPolarity(r.title);
    if (!c) continue;
    classified.push({
      claim: r.title,
      ...(r.source ? { venue: r.source } : {}),
      ...(r.url ? { marketUrl: r.url } : {}),
      cournotProbability: r.cournot_price,
      venuePrice: r.market_price,
      divergence: r.cournot_price - r.market_price,
      sources: [],
      fetchedAt,
      live,
      polarity: c.polarity,
      origin: 'ranking',
    });
  }
  return { all: rows.length, classified };
}

export function topByDivergence(events: EventRisk[], n: number): EventRisk[] {
  return [...events].sort((a, b) => Math.abs(b.divergence ?? 0) - Math.abs(a.divergence ?? 0)).slice(0, n);
}

function findFreshRanking(proofDir: string, ttlMs: number, now: number): { proof: any } | undefined {
  if (!existsSync(proofDir)) return undefined;
  let best: any;
  for (const f of readdirSync(proofDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const proof = JSON.parse(readFileSync(path.join(proofDir, f), 'utf8'));
      if (proof.kind !== DIVERGENCE_KIND || now - proof.fetchedAt > ttlMs) continue;
      if (!best || proof.fetchedAt > best.fetchedAt) best = proof;
    } catch {
      // ignore
    }
  }
  return best ? { proof: best } : undefined;
}

const LABELS = JSON.stringify({ cournot_above: 'Cournot above market', cournot_below: 'Cournot below market', link: 'View' });

/**
 * Cournot divergence ranking mapped into EventRisk rows (origin 'ranking', polarity-classified only).
 * Same budget rules as assessClaim: proof cache first (live: false), else one billable call if COURNOT_MAX_CALLS allows.
 * Runs the client with `divergence` only, never --per-call, so no payment can be approved.
 */
export async function assessDivergence(opts: DivergenceOpts = {}): Promise<EventRisk[]> {
  const now = opts.now ?? Date.now;
  const proofDir = opts.proofDir ?? COURNOT_PROOF_DIR;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const limit = opts.limit ?? 100;

  const cached = findFreshRanking(proofDir, ttl, now());
  if (cached) return mapRanking(cached.proof.rawResponse, cached.proof.fetchedAt, false).classified;

  reserveLiveCall(opts.maxCalls ?? maxCallsFromEnv());

  mkdirSync(proofDir, { recursive: true });
  const teeFile = path.join(proofDir, `.tee-div-${now()}-${process.pid}.jsonl`);
  const requestedAt = now();
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', COURNOT_RAW_TEE: teeFile, COURNOT_TEE_MATCH: '/intelligence/v1/divergence' };
  const key = opts.apiKey ?? process.env.COURNOT_API_KEY;
  if (key) env.COURNOT_API_KEY = key;
  for (const k of ['COURNOT_CREDENTIAL_DIR', 'COURNOT_API_KEY_BASE', 'COURNOT_API_BASE']) if (process.env[k]) env[k] = process.env[k]!;

  let stdout = '';
  let failure: string | undefined;
  try {
    const r = await execFileAsync(
      process.execPath,
      ['--import', COURNOT_TEE, opts.clientPath ?? COURNOT_CLIENT, 'divergence', '--limit', String(limit), '--count-text', String(limit), '--labels-json', LABELS],
      { env, timeout: 150_000, maxBuffer: 50 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (e: any) {
    failure = String(e?.stderr || e?.message || e).slice(0, 400);
  }

  // Keep the raw response whenever the server answered 200 with code 0, even if the client's own display step failed.
  let tee: any;
  try {
    const lines = readFileSync(teeFile, 'utf8').trim().split('\n');
    tee = JSON.parse(lines[lines.length - 1]);
  } catch {
    // none captured
  }
  let raw: any;
  if (tee?.status === 200) {
    try {
      raw = redactIp(JSON.parse(tee.body));
    } catch {
      raw = undefined;
    }
  }
  if (!raw || raw.code !== 0) {
    let state = 'unknown';
    try {
      state = JSON.parse(stdout.trim()).state;
    } catch {
      // ignore
    }
    throw new CournotCallError(failure ?? `Cournot divergence returned state "${state}"; no ranking obtained and no payment approved.`, state);
  }

  const fetchedAt = tee.receivedAt as number;
  const stamp = new Date(fetchedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const proof = {
    kind: DIVERGENCE_KIND,
    claim: DIVERGENCE_KIND,
    requestedLimit: limit,
    requestedAt,
    fetchedAt,
    billing: pickBilling(raw),
    rawResponse: raw,
    httpStatus: tee.status,
    clientCommit: clientCommit(),
    redactions: ['data.free_quota.ip'],
  };
  writeFileSync(path.join(proofDir, `${stamp}-divergence-ranking.json`), JSON.stringify(proof, null, 2) + '\n'); // before mapping
  try {
    unlinkSync(teeFile);
  } catch {
    // ignore
  }
  return mapRanking(raw, fetchedAt, true).classified;
}
