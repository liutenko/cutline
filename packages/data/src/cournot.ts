import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EventRisk } from '../../../shared/src/types.js';
import { PACKAGE_DIR, PROOFS_DIR } from './env.js';
import { mapProbabilityResponse } from './cournot-map.js';

const execFileAsync = promisify(execFile);

export const COURNOT_CLIENT = path.join(PACKAGE_DIR, 'vendor/cournot-skills/skills/cournot/scripts/cournot-client.mjs');
export const COURNOT_TEE = path.join(PACKAGE_DIR, 'src/cournot-tee.mjs');
export const COURNOT_PROOF_DIR = path.join(PROOFS_DIR, 'cournot');
export const DEFAULT_TTL_MS = 30 * 60_000;

export interface AssessOpts {
  /** Cournot/prediction-market id for the claim (free `resolve` step finds it). Required for a live call. */
  marketId: string;
  /** Set by our config, not by Cournot. */
  polarity: 'adverse' | 'favorable';
  /** Proof cache TTL. Default 30 min. */
  ttlMs?: number;
  /** Max live (billable) calls in this process. Default: env COURNOT_MAX_CALLS, else 0 (cache only). */
  maxCalls?: number;
  proofDir?: string;
  now?: () => number;
  /** Key for later calls. Default: env COURNOT_API_KEY (passed to the client through its own env handling). */
  apiKey?: string;
  /** Override for tests. */
  clientPath?: string;
}

export class CournotBudgetError extends Error {}
export class CournotCallError extends Error {
  constructor(message: string, readonly state?: string) {
    super(message);
  }
}

let liveCallsThisProcess = 0;
export function liveCallCount(): number {
  return liveCallsThisProcess;
}
/** For tests only. */
export function resetLiveCallCount(): void {
  liveCallsThisProcess = 0;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export interface CournotProof {
  claim: string;
  marketId: string;
  polarity: 'adverse' | 'favorable';
  requestedAt: number;
  fetchedAt: number;
  requestId?: string;
  /** Billing footer exactly as in the response (billing route, charged flag, quotas). */
  billing: Record<string, unknown>;
  /** Complete raw HTTP response body of the probability call (free_quota.ip redacted). */
  rawResponse: unknown;
  httpStatus: number;
  clientCommit?: string;
  redactions: string[];
}

function pickBilling(body: any): Record<string, unknown> {
  const d = body?.data ?? {};
  const out: Record<string, unknown> = {};
  for (const k of ['billing', 'charged', 'free_quota', 'api_key_quota', 'x402']) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

function findRequestId(body: any): string | undefined {
  const keys = new Set(['request_id', 'requestId', 'trace_id', 'traceId', 'id_request']);
  const seen = new Set<unknown>();
  const walk = (o: any): string | undefined => {
    if (!o || typeof o !== 'object' || seen.has(o)) return undefined;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (keys.has(k) && (typeof v === 'string' || typeof v === 'number')) return String(v);
    }
    for (const v of Object.values(o)) {
      const r = walk(v);
      if (r) return r;
    }
    return undefined;
  };
  return walk(body);
}

function redactIp(o: any): any {
  if (Array.isArray(o)) return o.map(redactIp);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'ip' ? '[redacted]' : redactIp(v)]));
  return o;
}

/** Newest proof for this claim within ttlMs, or undefined. */
export function findFreshProof(claim: string, proofDir: string, ttlMs: number, now: number): { file: string; proof: CournotProof } | undefined {
  if (!existsSync(proofDir)) return undefined;
  let best: { file: string; proof: CournotProof } | undefined;
  for (const f of readdirSync(proofDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const proof = JSON.parse(readFileSync(path.join(proofDir, f), 'utf8')) as CournotProof;
      if (proof.claim !== claim || typeof proof.fetchedAt !== 'number') continue;
      if (now - proof.fetchedAt > ttlMs) continue;
      if (!best || proof.fetchedAt > best.proof.fetchedAt) best = { file: path.join(proofDir, f), proof };
    } catch {
      // ignore unreadable files
    }
  }
  return best;
}

export function maxCallsFromEnv(): number {
  const n = Number(process.env.COURNOT_MAX_CALLS ?? '0');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Shared per-process billable-call budget. Counts before the call: an uncertain failure may still bill. */
export function reserveLiveCall(maxCalls: number): void {
  if (liveCallsThisProcess >= maxCalls) {
    throw new CournotBudgetError(`No fresh Cournot proof and the live call budget is ${maxCalls} (set COURNOT_MAX_CALLS to allow a live call).`);
  }
  liveCallsThisProcess += 1;
}

export function clientCommit(): string | undefined {
  try {
    const head = readFileSync(path.join(PACKAGE_DIR, 'vendor/cournot-skills/.git/HEAD'), 'utf8').trim();
    return head.startsWith('ref:') ? readFileSync(path.join(PACKAGE_DIR, 'vendor/cournot-skills/.git', head.slice(5)), 'utf8').trim() : head;
  } catch {
    return undefined;
  }
}

export { pickBilling, redactIp, findRequestId };

/**
 * Cournot Intelligence Oracle probability for `claim`.
 * Serves from the proof cache when fresh (live: false). Otherwise makes one billable call through the
 * official bundled client, subject to the per-process budget (COURNOT_MAX_CALLS, default 0).
 * Never approves a payment: the client is run with `prepare` only, never with --per-call.
 */
export async function assessClaim(claim: string, opts: AssessOpts): Promise<EventRisk> {
  const now = opts.now ?? Date.now;
  const proofDir = opts.proofDir ?? COURNOT_PROOF_DIR;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  const cached = findFreshProof(claim, proofDir, ttl, now());
  if (cached) {
    return mapProbabilityResponse({ claim, marketId: opts.marketId, polarity: opts.polarity, body: cached.proof.rawResponse, requestId: cached.proof.requestId, fetchedAt: cached.proof.fetchedAt, live: false });
  }

  const budget = opts.maxCalls ?? maxCallsFromEnv();
  if (liveCallsThisProcess >= budget) {
    throw new CournotBudgetError(`No fresh Cournot proof for this claim and the live call budget is ${budget} (set COURNOT_MAX_CALLS to allow a live call).`);
  }
  liveCallsThisProcess += 1; // count before the call: an uncertain failure may still bill

  mkdirSync(proofDir, { recursive: true });
  const teeFile = path.join(proofDir, `.tee-${now()}-${process.pid}.jsonl`);
  const requestedAt = now();
  const request = Buffer.from(JSON.stringify({ message: claim, market_ids: [opts.marketId] })).toString('base64');

  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', COURNOT_RAW_TEE: teeFile };
  const key = opts.apiKey ?? process.env.COURNOT_API_KEY;
  if (key) env.COURNOT_API_KEY = key;
  for (const k of ['COURNOT_CREDENTIAL_DIR', 'COURNOT_API_KEY_BASE', 'COURNOT_API_BASE']) if (process.env[k]) env[k] = process.env[k]!;

  let stdout = '';
  try {
    const r = await execFileAsync(
      process.execPath,
      ['--import', COURNOT_TEE, opts.clientPath ?? COURNOT_CLIENT, 'prepare', '--request-base64', request],
      { env, timeout: 150_000, maxBuffer: 20 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (e: any) {
    throw new CournotCallError(`Cournot client failed: ${String(e?.stderr || e?.message || e).slice(0, 400)}`);
  }

  let out: any;
  try {
    out = JSON.parse(stdout.trim());
  } catch {
    throw new CournotCallError('Cournot client returned non-JSON output');
  }
  if (out.state !== 'complete') {
    // payment_choice_required, rate_limited, key_invalid, ...: no assessment obtained, no payment approved.
    throw new CournotCallError(`Cournot returned state "${out.state}" (HTTP ${out.httpStatus ?? '?'}); no assessment obtained and no payment approved.`, out.state);
  }

  let teeLine: any;
  try {
    const lines = readFileSync(teeFile, 'utf8').trim().split('\n');
    teeLine = JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new CournotCallError('Cournot call completed but the raw response was not captured');
  }
  const rawBody = redactIp(JSON.parse(teeLine.body));
  const fetchedAt = teeLine.receivedAt as number;
  const requestId = findRequestId(rawBody);

  let clientCommit: string | undefined;
  try {
    const head = readFileSync(path.join(PACKAGE_DIR, 'vendor/cournot-skills/.git/HEAD'), 'utf8').trim();
    clientCommit = head.startsWith('ref:') ? readFileSync(path.join(PACKAGE_DIR, 'vendor/cournot-skills/.git', head.slice(5)), 'utf8').trim() : head;
  } catch {
    // optional
  }

  const proof: CournotProof = {
    claim,
    marketId: opts.marketId,
    polarity: opts.polarity,
    requestedAt,
    fetchedAt,
    requestId,
    billing: pickBilling(rawBody),
    rawResponse: rawBody,
    httpStatus: teeLine.status,
    clientCommit,
    redactions: ['data.free_quota.ip'],
  };
  const stamp = new Date(fetchedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const proofFile = path.join(proofDir, `${stamp}-${slugify(claim)}.json`);
  writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n'); // saved BEFORE mapping so a mapping bug never loses a billed response
  try {
    // remove the temp tee file now that the proof is saved
    (await import('node:fs')).unlinkSync(teeFile);
  } catch {
    // ignore
  }

  return mapProbabilityResponse({ claim, marketId: opts.marketId, polarity: opts.polarity, body: rawBody, requestId, fetchedAt, live: true });
}
