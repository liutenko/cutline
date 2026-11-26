import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { createServer, parseControl } from '../src/server.ts';
import { Desk, DEFAULT_AGENTS } from '../src/desk.ts';
import { DevSimProvider } from '../src/dev/DevSimProvider.ts';
import { DevRail } from '../src/dev/DevRail.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;

test('parseControl validates actions', () => {
  assert.deepEqual(parseControl({ action: 'shock', symbol: 'BNB', pct: -20 }), { action: 'shock', symbol: 'BNB', pct: -20 });
  assert.throws(() => parseControl({ action: 'rogue', agentId: 'nobody' }));
  assert.throws(() => parseControl({ action: 'nope' }));
});

test('HTTP API: state, control, SSE, CORS', async () => {
  const desk = new Desk({
    provider: new DevSimProvider({ seed: 3 }), railFactory: () => new DevRail(), railName: 'local',
    agents: DEFAULT_AGENTS.map((a, i) => ({ ...a, address: addr(10 + i) })), deskAddress: addr(1), riskAddress: addr(2),
    config: { ...DEFAULT_CONFIG }, mode: 'dev', manual: true,
  });
  const server = createServer(desk);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const s0 = await (await fetch(`${base}/api/state`)).json();
    assert.equal(s0.round.phase, 'idle');
    assert.equal(s0.mode, 'dev');
    assert.deepEqual(s0.onchainLinks, []);
    assert.equal(s0.agents.length, 3);

    const ac = new AbortController();
    const sse = await fetch(`${base}/api/events`, { signal: ac.signal });
    assert.equal(sse.headers.get('content-type'), 'text/event-stream');
    assert.equal(sse.headers.get('access-control-allow-origin'), '*');
    const reader = sse.body!.getReader();

    const r = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
    assert.deepEqual(await r.json(), { ok: true });
    await desk.tick();
    let buf = '';
    while (!buf.includes('"type":"tick"')) buf += new TextDecoder().decode((await reader.read()).value);
    const msgs = buf.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    assert.ok(msgs.some((m) => m.type === 'rail' && m.receipt.kind === 'open'));
    ac.abort();

    const bad = await fetch(`${base}/api/control`, { method: 'POST', body: '{"action":"bogus"}' });
    assert.equal(bad.status, 400);
    const opt = await fetch(`${base}/api/control`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
    const s1 = await (await fetch(`${base}/api/state`)).json();
    assert.equal(s1.round.tick, 1);
    assert.ok(s1.railState.allocations.desk);
  } finally {
    desk.dispose();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
