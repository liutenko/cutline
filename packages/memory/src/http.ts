// Minimal raw-HTTP client for the Living Brain REST API (https://api.livingbrain.com).
// Shapes come from the published OpenAPI file https://docs.livingbrain.com/openapi.json.
// Raw HTTP instead of @living-brain/sdk: the API is a handful of JSON calls, a fake fetch is
// trivial to test offline, and it avoids a dependency we cannot vet before the deadline.

export class LivingBrainError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'LivingBrainError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  apiKey: string;
  subjectId: string;
  fetch?: FetchLike;
  /** Extra attempts on 429, 5xx and network errors. Default 2. */
  retries?: number;
  /** Base backoff in ms (doubles each attempt). Default 300. Tests use 0. */
  backoffMs?: number;
  timeoutMs?: number;
}

export class LbHttp {
  private readonly f: FetchLike;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly o: HttpOptions) {
    this.f = o.fetch ?? ((u, i) => fetch(u, i));
    this.retries = o.retries ?? 2;
    this.backoffMs = o.backoffMs ?? 300;
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.o.baseUrl.replace(/\/+$/, '') + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.o.apiKey}`,
        'x-api-key': this.o.apiKey,
        'x-subject-id': this.o.subjectId,
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    };
    const label = `Living Brain ${method} ${path}`;
    let lastErr: LivingBrainError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0 && this.backoffMs > 0) await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (attempt - 1)));
      let res: Response;
      try {
        res = await this.f(url.toString(), { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        lastErr = new LivingBrainError(`${label} failed: network error (${(e as Error).message})`);
        continue;
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (res.ok) return json as T;
      // Error envelope: { statusCode, message, body: { message, error } }
      const msg = (json as { message?: unknown } | undefined)?.message;
      const detail = typeof msg === 'string' ? msg : Array.isArray(msg) ? msg.join('; ') : text.slice(0, 200);
      const safeDetail = detail.split(this.o.apiKey).join('[redacted]');
      if (res.status === 402 || /insufficient balance|payment required/i.test(safeDetail)) {
        throw new LivingBrainError(`${label} failed: HTTP ${res.status} Living Brain balance is empty: add prepaid credit`, res.status, json);
      }
      lastErr = new LivingBrainError(`${label} failed: HTTP ${res.status} ${safeDetail}`.trim(), res.status, json);
      if (res.status !== 429 && res.status < 500) throw lastErr; // 400/401/404 will not succeed on retry
    }
    throw lastErr ?? new LivingBrainError(`${label} failed`);
  }
}
