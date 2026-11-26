import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Instrument, Liquidity } from '../../../shared/src/types.js';
import { PROOFS_DIR } from './env.js';

const PRO_BASE = 'https://pro-api.coinmarketcap.com';
const KEYLESS_BASE = 'https://pro-api.coinmarketcap.com/public-api';

// Refresh windows. A desk that runs around the clock can stretch them with env to stay inside the monthly credit plan.
const ttlEnv = (name: string, dflt: number): number => (Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt);
export const QUOTE_TTL_MS = ttlEnv('CMC_QUOTE_TTL_MS', 60_000);
export const LIQUIDITY_TTL_MS = ttlEnv('CMC_LIQUIDITY_TTL_MS', 5 * 60_000);
export const FEAR_GREED_TTL_MS = ttlEnv('CMC_FEAR_GREED_TTL_MS', 5 * 60_000);

export interface CmcClientOpts {
  /** Pro API key. When empty the documented Keyless Public API is used. */
  apiKey?: string;
  /** Directory for calls.jsonl (Pro) and calls.keyless.jsonl. Default data/proofs/cmc. */
  logDir?: string;
  fetchImpl?: typeof fetch;
  /** Minimum gap between requests. Default 2200ms with a key, 6000ms keyless. */
  minGapMs?: number;
  /** Backoff base for rate-limit retries. Default 15000ms. Tests set it to 0. */
  backoffMs?: number;
  now?: () => number;
  /** Platform name used by the DEX endpoints. CoinMarketCap calls BNB Smart Chain "BSC". */
  dexPlatform?: string;
}

export interface CallLogEntry {
  ts: number;
  iso: string;
  mode: 'pro' | 'keyless';
  endpoint: string;
  params: Record<string, string>;
  httpStatus: number;
  errorCode: string | null;
  creditCount: number | null;
  attempt: number;
}

export interface QuoteRow {
  cmcId: number;
  symbol: string;
  price: number;
  pctChange1h?: number;
  pctChange24h?: number;
  /** ms epoch of quote.last_updated */
  ts: number;
}

export interface DexTokenInfo {
  liquidityUsd: number;
  volume24hUsd: number;
  topPool?: { exchange: string; pair: string; liquidityUsd: number };
}

// ---------- pure mapping (unit tested) ----------

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** /v3/cryptocurrency/quotes/latest -> rows. Handles array data (v3) and id-keyed objects (v2). */
export function mapQuotes(body: any, convert = 'USD'): QuoteRow[] {
  const raw = body?.data;
  if (!raw) return [];
  const items: any[] = Array.isArray(raw) ? raw : Object.values(raw).flatMap((v) => (Array.isArray(v) ? v : [v]));
  const rows: QuoteRow[] = [];
  for (const it of items) {
    const quotes = Array.isArray(it?.quote) ? it.quote : it?.quote ? Object.entries(it.quote).map(([symbol, q]: [string, any]) => ({ symbol, ...q })) : [];
    const q = quotes.find((x: any) => x.symbol === convert) ?? quotes[0];
    const price = num(q?.price);
    if (price === undefined || typeof it?.id !== 'number') continue;
    const ts = Date.parse(q?.last_updated ?? it?.last_updated ?? '');
    rows.push({
      cmcId: it.id,
      symbol: String(it.symbol),
      price,
      pctChange1h: num(q.percent_change_1h),
      pctChange24h: num(q.percent_change_24h),
      ts: Number.isFinite(ts) ? ts : Date.parse(body?.status?.timestamp ?? '') || Date.now(),
    });
  }
  return rows;
}

/** /v3/fear-and-greed/latest -> 0..100 */
export function mapFearGreed(body: any): number | undefined {
  return num(body?.data?.value);
}

/** /v1/dex/token -> liquidity (USD, all pools), 24h volume, biggest pool. */
export function mapDexToken(body: any): DexTokenInfo | undefined {
  const d = body?.data;
  if (!d) return undefined;
  const liquidityUsd = num(d.liqUsd);
  if (liquidityUsd === undefined) return undefined;
  const s24 = Array.isArray(d.sts) ? d.sts.find((s: any) => s?.tp === '24h') : undefined;
  const pools: any[] = Array.isArray(d.pls) ? d.pls : [];
  const top = [...pools].sort((a, b) => (num(b.liqUsd) ?? 0) - (num(a.liqUsd) ?? 0))[0];
  return {
    liquidityUsd,
    volume24hUsd: num(s24?.vu) ?? 0,
    topPool: top
      ? { exchange: String(top.exn ?? 'unknown DEX'), pair: `${top.t0?.sym ?? '?'}/${top.t1?.sym ?? '?'}`, liquidityUsd: num(top.liqUsd) ?? 0 }
      : undefined,
  };
}

export function liquidityFromDex(symbol: string, info: DexTokenInfo, ts: number, mode: 'pro' | 'keyless'): Liquidity {
  const pool = info.topPool ? `; top pool ${info.topPool.exchange} ${info.topPool.pair}` : '';
  return {
    symbol,
    dexLiquidityUsd: info.liquidityUsd,
    dexVolume24hUsd: info.volume24hUsd,
    source: `CoinMarketCap DEX API /v1/dex/token (BSC, all pools${pool})${mode === 'keyless' ? ' [keyless]' : ''}`,
    ts,
  };
}

// ---------- client ----------

export class CmcError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly errorCode: string | null) {
    super(message);
  }
}

const KEY_FALLBACK_CODES = new Set(['1001', '1002', '1005', '1006', '1007', '1008', '1009', '1010', '1011']);

export class CmcClient {
  readonly mode: 'pro' | 'keyless';
  /** Set when a keyed call was refused (plan or key) and answered through the keyless API instead. */
  /** Running totals for this process (credits as reported by CoinMarketCap). */
  credits = 0;
  calls = 0;
  fallbacks: { endpoint: string; errorCode: string | null; httpStatus: number }[] = [];
  private readonly apiKey: string;
  private readonly logDir: string;
  private readonly f: typeof fetch;
  private readonly minGap: number;
  private readonly backoff: number;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  readonly dexPlatform: string;

  constructor(opts: CmcClientOpts = {}) {
    this.apiKey = (opts.apiKey ?? '').trim();
    this.mode = this.apiKey ? 'pro' : 'keyless';
    this.logDir = opts.logDir ?? path.join(PROOFS_DIR, 'cmc');
    this.f = opts.fetchImpl ?? fetch;
    this.minGap = opts.minGapMs ?? (this.apiKey ? 2200 : 6000);
    this.backoff = opts.backoffMs ?? 15_000;
    this.now = opts.now ?? Date.now;
    this.dexPlatform = opts.dexPlatform ?? 'BSC';
  }

  private log(entry: CallLogEntry): void {
    try {
      mkdirSync(this.logDir, { recursive: true });
      const file = entry.mode === 'pro' ? 'calls.jsonl' : 'calls.keyless.jsonl';
      appendFileSync(path.join(this.logDir, file), JSON.stringify(entry) + '\n');
    } catch {
      // logging must never break a data call
    }
  }

  /** Serialised, rate-paced request. `endpoint` is the Pro path, e.g. /v3/cryptocurrency/quotes/latest. */
  request(endpoint: string, params: Record<string, string>): Promise<any> {
    const run = async () => {
      const wait = this.lastAt + this.minGap - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await this.call(endpoint, params, this.mode);
      } catch (e) {
        if (this.mode === 'pro' && e instanceof CmcError && (e.httpStatus === 401 || e.httpStatus === 403 || (e.errorCode && KEY_FALLBACK_CODES.has(e.errorCode)))) {
          this.fallbacks.push({ endpoint, errorCode: e.errorCode, httpStatus: e.httpStatus });
          return await this.call(endpoint, params, 'keyless');
        }
        throw e;
      } finally {
        this.lastAt = this.now();
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async call(endpoint: string, params: Record<string, string>, mode: 'pro' | 'keyless'): Promise<any> {
    const url = `${mode === 'pro' ? PRO_BASE : KEYLESS_BASE}${endpoint}?${new URLSearchParams(params).toString()}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (mode === 'pro') headers['X-CMC_PRO_API_KEY'] = this.apiKey;
    const maxAttempts = 4;
    let last: CmcError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await this.f(url, { headers });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        // non-JSON body
      }
      const status = body?.status ?? {};
      const errorCode = status.error_code !== undefined && String(status.error_code) !== '0' ? String(status.error_code) : null;
      const ts = this.now();
      this.log({
        ts,
        iso: new Date(ts).toISOString(),
        mode,
        endpoint,
        params,
        httpStatus: res.status,
        errorCode,
        creditCount: typeof status.credit_count === 'number' ? status.credit_count : null,
        attempt,
      });
      this.calls += 1;
      if (typeof status.credit_count === 'number') this.credits += status.credit_count;
      if (res.ok && !errorCode) return body;
      last = new CmcError(`CoinMarketCap ${endpoint} failed: HTTP ${res.status} ${status.error_message ?? ''}`.trim(), res.status, errorCode);
      const rateLimited = res.status === 429 || errorCode === '1008' || errorCode === '1022';
      if (rateLimited && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, this.backoff * attempt));
        continue;
      }
      break;
    }
    throw last!;
  }

  // ----- typed endpoints -----

  async quotes(cmcIds: number[]): Promise<QuoteRow[]> {
    const body = await this.request('/v3/cryptocurrency/quotes/latest', { id: cmcIds.join(','), convert: 'USD' });
    return mapQuotes(body);
  }

  async fearGreed(): Promise<number | undefined> {
    return mapFearGreed(await this.request('/v3/fear-and-greed/latest', {}));
  }

  async dexToken(address: string): Promise<DexTokenInfo | undefined> {
    return mapDexToken(await this.request('/v1/dex/token', { platform: this.dexPlatform, address }));
  }
}

// ---------- cached source used by the provider ----------

export class CmcSource {
  private quoteCache?: { at: number; rows: Map<number, QuoteRow> };
  private fgCache?: { at: number; value: number | undefined };
  private liqCache = new Map<string, { at: number; liq: Liquidity }>();
  private liqInFlight?: Promise<void>;
  lastError?: string;

  constructor(readonly client: CmcClient, private readonly now: () => number = Date.now) {}

  async quotes(instruments: Instrument[]): Promise<Map<number, QuoteRow>> {
    const t = this.now();
    if (this.quoteCache && t - this.quoteCache.at < QUOTE_TTL_MS) return this.quoteCache.rows;
    const rows = await this.client.quotes(instruments.map((i) => i.cmcId));
    this.quoteCache = { at: t, rows: new Map(rows.map((r) => [r.cmcId, r])) };
    return this.quoteCache.rows;
  }

  async fearGreed(): Promise<number | undefined> {
    const t = this.now();
    if (this.fgCache && t - this.fgCache.at < FEAR_GREED_TTL_MS) return this.fgCache.value;
    try {
      const value = await this.client.fearGreed();
      this.fgCache = { at: t, value };
      return value;
    } catch (e) {
      this.lastError = (e as Error).message;
      return this.fgCache?.value;
    }
  }

  /**
   * Liquidity per symbol, cached 5 min. The first fill blocks; later refreshes run in the background
   * and the previous values are served meanwhile, so a slow keyless pool never stalls a tick.
   */
  async liquidity(instruments: Instrument[]): Promise<Record<string, Liquidity>> {
    const t = this.now();
    const withAddr = instruments.filter((i) => i.bscAddress);
    const stale = withAddr.filter((i) => {
      const c = this.liqCache.get(i.symbol);
      return !c || t - c.at >= LIQUIDITY_TTL_MS;
    });
    if (stale.length && !this.liqInFlight) {
      this.liqInFlight = (async () => {
        for (const inst of stale) {
          try {
            const info = await this.client.dexToken(inst.bscAddress!);
            if (info) this.liqCache.set(inst.symbol, { at: this.now(), liq: liquidityFromDex(inst.symbol, info, this.now(), this.client.mode) });
          } catch (e) {
            this.lastError = (e as Error).message;
          }
        }
      })().finally(() => {
        this.liqInFlight = undefined;
      });
    }
    const neverFilled = withAddr.some((i) => !this.liqCache.has(i.symbol));
    if (neverFilled && this.liqInFlight) await this.liqInFlight;
    const out: Record<string, Liquidity> = {};
    for (const i of withAddr) {
      const c = this.liqCache.get(i.symbol);
      if (c) out[i.symbol] = c.liq;
    }
    return out;
  }
}
