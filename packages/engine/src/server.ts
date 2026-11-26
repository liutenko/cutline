// HTTP API: GET /api/state, GET /api/events (SSE), POST /api/control. CORS open.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { ControlAction, DeskEvent } from '../../../shared/src/types.ts';
import type { Desk, EngineControl } from './desk.ts';
import { errMsg } from './desk.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const AGENT_IDS = new Set(['momentum', 'rwa', 'event']);

export function parseControl(body: unknown): EngineControl {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || typeof b.action !== 'string') throw new Error('Body must be a JSON ControlAction');
  switch (b.action) {
    case 'start':
    case 'pause':
    case 'reset':
    case 'close-round':
      return { action: b.action };
    case 'recall':
      return { action: 'recall' };
    case 'rogue':
      if (typeof b.agentId !== 'string' || !AGENT_IDS.has(b.agentId)) throw new Error('rogue needs agentId: momentum, rwa or event');
      return { action: 'rogue', agentId: b.agentId as 'momentum' | 'rwa' | 'event' };
    case 'shock':
      if (typeof b.symbol !== 'string' || typeof b.pct !== 'number') throw new Error('shock needs symbol (string) and pct (number)');
      return { action: 'shock', symbol: b.symbol, pct: b.pct };
    default:
      throw new Error(`Unknown action "${b.action}"`);
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 64_000) throw new Error('Body too large');
  }
  return s ? JSON.parse(s) : null;
}

export function createServer(desk: Desk): http.Server {
  const clients = new Set<http.ServerResponse>();
  const onEvent = (e: DeskEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(line);
  };
  desk.on('event', onEvent);
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 15_000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, desk.state());
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          ...CORS,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/control') {
        let action: EngineControl;
        try {
          action = parseControl(await readBody(req));
        } catch (e) {
          return json(res, 400, { ok: false, error: errMsg(e) });
        }
        try {
          await desk.control(action);
        } catch (e) {
          return json(res, 409, { ok: false, error: errMsg(e) });
        }
        return json(res, 200, { ok: true });
      }
      json(res, 404, { ok: false, error: 'Not found' });
    } catch (e) {
      json(res, 500, { ok: false, error: errMsg(e) });
    }
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    desk.off('event', onEvent);
    for (const c of clients) c.end();
  });
  return server;
}

async function main(): Promise<void> {
  const { createDeskFromEnv } = await import('./wiring.ts');
  let created;
  try {
    created = await createDeskFromEnv();
  } catch (e) {
    console.error(`[engine] Startup failed: ${errMsg(e)}`);
    process.exit(1);
  }
  const { desk, summary } = created;
  for (const s of summary) console.log(`[engine] ${s}`);
  const port = Number(process.env.PORT || 8787);
  const server = createServer(desk);
  server.listen(port, () => console.log(`[engine] Listening on http://localhost:${port} (GET /api/state, GET /api/events, POST /api/control)`));
  if (process.env.AUTOSTART === '1') await desk.control({ action: 'start' });
  const stop = () => {
    desk.dispose();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
