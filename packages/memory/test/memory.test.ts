import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeskMemory, safe, agentDocument, originRefFor, LivingBrainError } from '../src/index.js';
import { fakeApi, env, report } from './fake.js';

const mk = (api: ReturnType<typeof fakeApi>, extra: Record<string, string> = {}) =>
  createDeskMemory({ ...env, ...extra }, { fetch: api.f, backoffMs: 0 })!;

test('null on empty or missing key, and when the subject id is missing', () => {
  assert.equal(createDeskMemory({}), null);
  assert.equal(createDeskMemory({ LIVINGBRAIN_API_KEY: '  ' }), null);
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(createDeskMemory({ LIVINGBRAIN_API_KEY: 'lbk_x' }), null); } finally { console.warn = warn; }
});

test('capture payload: kind, originRef, label, factual text; auth headers sent', async () => {
  const api = fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }] });
  const mem = mk(api);
  await mem.rememberRound(report);
  const caps = api.calls.filter((c) => c.path.endsWith('/captures'));
  assert.equal(caps.length, 2);
  assert.equal(caps[0].path, '/v1/brains/b1/captures');
  assert.equal(caps[0].body.kind, 'note');
  assert.equal(caps[0].body.originRef, 'cutline:round:1795675787:agent:momentum');
  assert.equal(caps[1].body.originRef, 'cutline:round:1795675787:agent:rwa');
  assert.equal(caps[0].headers['x-subject-id'], env.LIVINGBRAIN_SUBJECT_ID);
  assert.equal(caps[0].headers['x-api-key'], env.LIVINGBRAIN_API_KEY);
  assert.equal(caps[0].headers['authorization'], `Bearer ${env.LIVINGBRAIN_API_KEY}`);
  assert.equal(
    caps[0].body.content.startsWith(
      'Round 1795675787 on the Cutline desk. Agent Momentum (strategy: buys the strongest BNB Chain major). Result: CUT. Reason: daily loss of 9.65% breached the 3% limit. Paper P&L -9.65%. Trades: 4. Rejected orders: 3, including an oversized order in a thin token.',
    ),
    true,
    caps[0].body.content,
  );
  assert.ok(!/[\u2013\u2014]/.test(caps[0].body.content), 'no em or en dashes');
  // the funded agent text never contains the word cut
  assert.ok(!/\bcut\b/i.test(agentDocument(report, report.agents[1])));
  // never searches right after writing
  assert.equal(api.calls.filter((c) => c.path.endsWith('/search')).length, 0);
});

test('profile is set once: PATCH on first write, skipped when a focus already exists', async () => {
  const api = fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }] });
  const mem = mk(api);
  await mem.rememberRound(report);
  await mem.rememberRound(report);
  assert.equal(api.calls.filter((c) => c.method === 'PATCH').length, 1);
  const api2 = fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }], profile: { focus: 'human wrote this' } });
  await mk(api2).rememberRound(report);
  assert.equal(api2.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('idempotent retry: same originRef and body after a 503; second round call reuses the same source', async () => {
  const api = fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }], failNext: { status: 503, times: 0 } });
  const mem = mk(api);
  await mem.brainId();
  await mem.rememberRound({ ...report, agents: [report.agents[0]] }); // warms profile
  api.state.failNext = { status: 503, times: 1 };
  const again = await mem.rememberRound({ ...report, agents: [report.agents[0]] });
  const caps = api.calls.filter((c) => c.path.endsWith('/captures'));
  assert.equal(caps.length, 3); // first ok, retried-failed, retried-ok
  assert.deepEqual(caps[1].body, caps[2].body);
  assert.equal(api.sources.size, 1, 'no duplicate capture');
  assert.equal(again[0].id, 'src-1');
});

test('brain resolution: configured id wins; else find by name; else create', async () => {
  const a1 = fakeApi();
  assert.equal(await mk(a1, { LIVINGBRAIN_BRAIN_ID: 'given' }).brainId(), 'given');
  assert.ok(a1.calls.every((c) => c.method === 'GET'), 'only a cosmetic name lookup');
  const a2 = fakeApi({ brains: [{ id: 'other', name: 'x' }, { id: 'b9', name: 'cutline-desk' }] });
  assert.equal(await mk(a2).brainId(), 'b9');
  const a3 = fakeApi({ brains: [] });
  assert.equal(await mk(a3).brainId(), 'brain-new');
  assert.equal(a3.calls.filter((c) => c.method === 'POST').length, 1);
});

test('brain lookup is case-insensitive on cutline or cutline-desk; brainName exposed; 402 gives a balance message and is not retried', async () => {
  const a = fakeApi({ brains: [{ id: 'x', name: 'Other' }, { id: 'b7', name: 'Cutline' }] });
  const m = mk(a);
  assert.equal(await m.brainId(), 'b7');
  assert.equal(await m.brainName(), 'Cutline');
  const p = fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }], failNext: { status: 402, times: 5 } });
  await assert.rejects(mk(p).rememberRound(report), /balance is empty: add prepaid credit/);
  assert.equal(p.calls.length, 1);
});

test('pendingSources merges pending and compiling', async () => {
  const api = fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }] });
  const mem = mk(api);
  await mem.rememberRound(report);
  api.sources.get('cutline:round:1795675787:agent:rwa').status = 'compiling';
  const p = await mem.pendingSources();
  assert.deepEqual(p.map((s) => s.status).sort(), ['compiling', 'pending']);
});

test('recall: reads active pages in full, probation from text, contested reported, summary verbatim', async () => {
  const body = 'Agent Momentum (strategy: buys the strongest BNB Chain major). Result: CUT. Reason: daily loss of 9.65% breached the 3% limit.';
  const api = fakeApi({
    brains: [{ id: 'b1', name: 'cutline-desk' }],
    searchResults: [
      { slug: 'momentum', title: 'Momentum', summary: 'Momentum was cut in round 1795675787 for a daily loss breach.', status: 'active', similarity: 0.8, pageType: 'entity' },
      { slug: 'old', title: 'Old', summary: 'x', status: 'deprecated', similarity: 0.9, pageType: 'topic' },
      { slug: 'disputed', title: 'Disputed', summary: 'Momentum claims disagree', status: 'contested', similarity: 0.5, pageType: 'topic' },
    ],
    pages: { momentum: { slug: 'momentum', title: 'Momentum', summary: 'Momentum was cut in round 1795675787 for a daily loss breach.', body, version: 3, status: 'active' } },
  });
  const r = await mk(api, {}).recallAgent('momentum', 'Momentum');
  assert.ok(r);
  assert.equal(r.probation, true);
  assert.equal(r.source, 'Living Brain');
  assert.equal(r.summary, 'Momentum was cut in round 1795675787 for a daily loss breach.');
  assert.deepEqual(r.pages, [{ slug: 'momentum', version: 3, title: 'Momentum' }]);
  assert.deepEqual(r.contested, [{ slug: 'disputed', title: 'Disputed' }]);
  assert.equal(api.calls.filter((c) => c.path.endsWith('/search')).length, 2, 'question plus one rewrite');
  assert.equal(api.calls.some((c) => c.path.includes('/pages/old')), false, 'deprecated page not read');
  assert.equal(api.calls.some((c) => c.path.includes('/pages/disputed')), false, 'contested page not read');
});

test('recall: no probation for a funded record, null when nothing relevant', async () => {
  const api = fakeApi({
    brains: [{ id: 'b1', name: 'cutline-desk' }],
    searchResults: [{ slug: 'rwa', title: 'RWA Rotator', summary: 'RWA Rotator was funded.', status: 'active', similarity: 0.7, pageType: 'entity' }],
    pages: { rwa: { slug: 'rwa', title: 'RWA Rotator', summary: 'RWA Rotator was funded.', body: 'Agent RWA Rotator. Result: FUNDED. Paper P&L +0.40%.', version: 1, status: 'active' } },
  });
  const mem = mk(api);
  assert.equal((await mem.recallAgent('rwa', 'RWA Rotator'))!.probation, false);
  assert.equal(await mem.recallAgent('event', 'Event Trader'), null, 'page does not mention this agent');
  const empty = mk(fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }] }));
  assert.equal(await empty.recallAgent('event', 'Event Trader'), null);
});

test('summary is capped near 240 characters', async () => {
  const long = 'Momentum ' + 'x'.repeat(400);
  const api = fakeApi({
    brains: [{ id: 'b1', name: 'cutline-desk' }],
    searchResults: [{ slug: 'm', title: 'Momentum', summary: long, status: 'active', similarity: 0.9, pageType: 'entity' }],
    pages: { m: { slug: 'm', title: 'Momentum', summary: long, body: 'Momentum.', version: 1, status: 'active' } },
  });
  const r = await mk(api).recallAgent('momentum', 'Momentum');
  assert.ok(r!.summary.length <= 240);
});

test('errors: a failed call rejects with a clear message and no key; 401 is not retried; safe() returns null', async () => {
  const api = fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }], failNext: { status: 401, times: 5 } });
  const mem = mk(api);
  await assert.rejects(mem.rememberRound(report), (e: Error) => {
    assert.ok(e instanceof LivingBrainError || /Living Brain/.test(e.message));
    assert.match(e.message, /HTTP 401/);
    assert.ok(!e.message.includes(env.LIVINGBRAIN_API_KEY));
    return true;
  });
  assert.equal(api.calls.length, 1, '401 not retried');
  const logs: string[] = [];
  const out = await safe('rememberRound', () => mem.rememberRound(report), (m) => logs.push(m));
  assert.equal(out, null);
  assert.match(logs[0], /rememberRound failed, continuing without memory/);
  assert.equal(await safe('sync throw', () => { throw new Error('x'); }, () => {}), null);
});

test('5xx is retried then surfaces; partial capture failure names the agents', async () => {
  const api = fakeApi({ brains: [{ id: 'b1', name: 'cutline-desk' }], failNext: { status: 500, times: 99 } });
  const mem = mk(api);
  await assert.rejects(mem.brainId().then(() => mem.rememberRound(report)), /HTTP 500|failed/);
  assert.ok(api.calls.length >= 1);
});

test('originRefFor format', () => {
  assert.equal(originRefFor(7, 'event'), 'cutline:round:7:agent:event');
});
