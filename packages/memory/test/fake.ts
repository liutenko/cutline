import type { FetchLike } from '../src/http.js';

export interface Call { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body?: any }

/** In-memory fake of the Living Brain REST API: just what the desk uses. Fixtures only, tests only. */
export function fakeApi(opts: { pages?: Record<string, any>; searchResults?: any[]; failNext?: { status: number; times: number }; brains?: any[]; profile?: any } = {}) {
  const calls: Call[] = [];
  const sources = new Map<string, any>(); // by originRef
  const state = { brains: opts.brains ?? [], profile: opts.profile ?? { focus: '' }, failNext: opts.failNext };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

  const f: FetchLike = async (url, init) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? 'GET',
      path: u.pathname,
      query: u.searchParams,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    if (state.failNext && state.failNext.times > 0) {
      state.failNext.times--;
      return json(state.failNext.status, { statusCode: state.failNext.status, message: 'boom' });
    }
    const p = call.path;
    if (p === '/v1/brains' && call.method === 'GET') return json(200, state.brains);
    if (p === '/v1/brains' && call.method === 'POST') {
      const b = { id: 'brain-new', name: call.body.name };
      state.brains.push(b);
      return json(201, b);
    }
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/v1\/brains\/[^/]+\/profile$/))) {
      if (call.method === 'PATCH') { state.profile = { ...state.profile, ...call.body }; return json(200, state.profile); }
      return json(200, state.profile);
    }
    if (p.endsWith('/captures') && call.method === 'POST') {
      const ref = call.body.originRef as string;
      const existing = sources.get(ref);
      if (existing) { existing.content = call.body.content; return json(201, existing); }
      const s = { id: `src-${sources.size + 1}`, originRef: ref, status: 'pending', label: call.body.label, content: call.body.content };
      sources.set(ref, s);
      return json(201, s);
    }
    if (p.endsWith('/sources')) {
      const st = call.query.get('status');
      return json(200, { items: [...sources.values()].filter((s) => s.status === st), total: 0, limit: 100, offset: 0 });
    }
    if (p.endsWith('/search')) return json(201, opts.searchResults ?? []);
    if ((m = p.match(/\/pages\/([^/]+)$/))) {
      const page = opts.pages?.[decodeURIComponent(m[1])];
      return page ? json(200, page) : json(404, { statusCode: 404, message: 'Page not found' });
    }
    return json(404, { statusCode: 404, message: `unhandled ${call.method} ${p}` });
  };
  return { f, calls, sources, state };
}

export const env = { LIVINGBRAIN_API_KEY: 'lbk_test_not_real', LIVINGBRAIN_SUBJECT_ID: '3f2b8c1e-7a4d-4e9b-9c2a-5d6e7f8a9b0c' };

export const report = {
  roundId: 1795675787,
  closedAt: Date.UTC(2026, 10, 26, 10, 0, 0),
  eventMultiplier: 0.8,
  scorecardTx: '0xabc',
  agents: [
    { agentId: 'momentum' as const, name: 'Momentum', strategy: 'buys the strongest BNB Chain major', status: 'cut' as const, pnlPct: -9.65, trades: 4, rejectedOrders: 3, cutReason: 'daily loss of 9.65% breached the 3% limit', rogue: true, notableRejections: ['an oversized order in a thin token'] },
    { agentId: 'rwa' as const, name: 'RWA Rotator', strategy: 'rotates into tokenized gold and stock', status: 'funded' as const, pnlPct: 0.4, trades: 3, rejectedOrders: 0, notableRejections: [] },
  ],
};
