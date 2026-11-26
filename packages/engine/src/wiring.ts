// The one place where the engine meets the other packages (data, rail, contracts).
// DATA=dev may fall back to in-package dev stand-ins with a clear warning.
// DATA=live, DATA=replay and any Yellow rail never fall back: a missing package is a hard error.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { keccak256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AgentId, DataProvider, MarketSnapshot, RailName, SettlementRail } from '../../../shared/src/types.ts';
import { Desk, DEFAULT_AGENTS, errMsg, type AgentSpec, type DeskDeps, type ScorecardPort } from './desk.ts';
import { configFromEnv } from './config.ts';
import { DevSimProvider } from './dev/DevSimProvider.ts';
import { DevRail } from './dev/DevRail.ts';
import type { Brain } from './agents/types.ts';
import { brainOptionsFromEnv, createRuleBrain } from './agents/RuleBrain.ts';
import { cachedOnchainLinks } from './onchain.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const ENV_PATH = path.join(REPO_ROOT, '.env');

const DATA_ENTRY = '../../data/src/index.ts';
const RAIL_ENTRY = '../../rail/src/index.ts';
const SCORECARD_ENTRY = '../../../contracts/src/client.ts';

export type DataMode = 'dev' | 'live' | 'replay';
type Env = Record<string, string | undefined>;
type Warn = (msg: string) => void;

export function loadEnv(): Env {
  if (existsSync(ENV_PATH)) loadDotenv({ path: ENV_PATH, quiet: true } as never);
  return process.env;
}

const AGENT_KEY_ENV: Record<AgentId, string> = {
  momentum: 'AGENT_MOMENTUM_KEY',
  rwa: 'AGENT_RWA_KEY',
  event: 'AGENT_EVENT_KEY',
};

function addressFromKey(env: Env, name: string, data: DataMode, warn: Warn): Hex {
  const raw = env[name]?.trim();
  if (raw) {
    const k = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
    try {
      return privateKeyToAccount(k).address;
    } catch {
      throw new Error(`${name} in .env is not a valid private key`);
    }
  }
  if (data !== 'dev') throw new Error(`${name} is missing from .env`);
  const a = `0x${keccak256(toBytes(`proving-ground dev ${name}`)).slice(-40)}` as Hex;
  warn(`${name} is not set; using a dev placeholder address ${a}. DATA=dev only.`);
  return a;
}

async function tryImport(spec: string): Promise<Record<string, unknown>> {
  return (await import(spec)) as Record<string, unknown>;
}

export interface Wiring {
  deps: DeskDeps;
  /** The shared LLM gate, when the LLM layer is on. */
  gate: import('./agents/LlmBrain.ts').LlmGate | null;
  /** What was actually wired, for the startup log. */
  summary: string[];
}

export async function wire(env: Env = loadEnv(), opts: { warn?: Warn } = {}): Promise<Wiring> {
  const summary: string[] = [];
  const warn: Warn = (m) => {
    summary.push(`WARN ${m}`);
    (opts.warn ?? ((x: string) => console.warn(`[engine] ${x}`)))(m);
  };
  const data = (env.DATA?.trim() || 'live') as DataMode;
  if (!['dev', 'live', 'replay'].includes(data)) throw new Error(`DATA must be dev, live or replay (got "${data}")`);
  const railName = (env.RAIL?.trim() || 'local') as RailName;
  if (!['local', 'yellow-sandbox', 'yellow-mainnet'].includes(railName)) {
    throw new Error(`RAIL must be local, yellow-sandbox or yellow-mainnet (got "${railName}")`);
  }
  const config = configFromEnv(env);

  // ---- data ----
  let provider: DataProvider;
  if (data === 'dev') {
    provider = new DevSimProvider({ seed: Number(env.DEV_SEED ?? 42) });
    summary.push('data: DevSimProvider (dev simulation, not live data)');
  } else {
    let mod: Record<string, unknown>;
    try {
      mod = await tryImport(DATA_ENTRY);
    } catch (e) {
      throw new Error(`DATA=${data} needs packages/data, which failed to load: ${errMsg(e)}`);
    }
    if (data === 'live') {
      const create = mod.createLiveProvider as ((o: { env: Env; priceToleranceBps?: number }) => DataProvider) | undefined;
      if (typeof create !== 'function') throw new Error('packages/data does not export createLiveProvider');
      provider = create({ env, priceToleranceBps: config.priceToleranceBps });
      const record = mod.recordSnapshot as ((s: MarketSnapshot, f: string) => unknown) | undefined;
      if (typeof record === 'function' && env.RECORD !== '0') {
        provider = withRecorder(provider, record, warn);
        summary.push('data: live provider (packages/data), recording to data/recordings/<date>.jsonl');
      } else {
        summary.push('data: live provider (packages/data)');
      }
    } else {
      const create = mod.createReplayProvider as ((f: string) => DataProvider) | undefined;
      if (typeof create !== 'function') throw new Error('packages/data does not export createReplayProvider');
      const file = env.REPLAY_FILE?.trim();
      if (!file) throw new Error('DATA=replay needs REPLAY_FILE (path to a data/recordings/*.jsonl file)');
      provider = create(path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file));
      summary.push(`data: replay of ${file} (packages/data)`);
    }
  }

  // ---- rail ----
  let railFactory: () => SettlementRail;
  try {
    const mod = await tryImport(RAIL_ENTRY);
    const createRail = mod.createRail as ((n: RailName, e: Env) => SettlementRail) | undefined;
    if (typeof createRail !== 'function') throw new Error('packages/rail does not export createRail');
    // Construct once now so configuration errors surface at startup, not at the first round.
    createRail(railName, env);
    railFactory = () => createRail(railName, env);
    summary.push(`rail: ${railName} (packages/rail)`);
  } catch (e) {
    if (railName !== 'local' || data !== 'dev') {
      throw new Error(`RAIL=${railName} with DATA=${data} needs packages/rail, which failed: ${errMsg(e)}`);
    }
    warn(`packages/rail is unavailable (${errMsg(e)}); using the in-memory DevRail stand-in. DATA=dev only.`);
    railFactory = () => new DevRail();
    summary.push('rail: DevRail (in-memory dev stand-in)');
  }

  // ---- scorecard ----
  let scorecard: ScorecardPort | null = null;
  try {
    const mod = await tryImport(SCORECARD_ENTRY);
    const create = mod.createScorecardClient as ((e: Env) => ScorecardPort | null) | undefined;
    if (typeof create !== 'function') throw new Error('contracts/src/client.ts does not export createScorecardClient');
    scorecard = create(env);
    summary.push(scorecard ? 'scorecard: Scorecard contract client (contracts)' : 'scorecard: not configured (SCORECARD_ADDRESS empty)');
  } catch (e) {
    if (data !== 'dev' && env.SCORECARD_ADDRESS?.trim()) {
      throw new Error(`SCORECARD_ADDRESS is set but the scorecard client failed: ${errMsg(e)}`);
    }
    warn(`Scorecard client unavailable (${errMsg(e)}); round results will not be written on-chain.`);
  }

  const scorecardFeeds = parseFeeds(env.SCORECARD_FEEDS, warn);
  if (scorecard) summary.push(`scorecard feeds: ${Object.keys(scorecardFeeds).sort().join(', ') || 'none (empty arrays)'}`);

  // ---- participants ----
  const deskAddress = addressFromKey(env, 'DESK_KEY', data, warn);
  const riskAddress = addressFromKey(env, 'RISK_KEY', data, warn);
  const agents: AgentSpec[] = DEFAULT_AGENTS.map((a) => ({ ...a, address: addressFromKey(env, AGENT_KEY_ENV[a.agentId], data, warn) }));

  // ---- brains ----
  const brainOptions = brainOptionsFromEnv(env);
  const brains: Partial<Record<AgentId, Brain>> = {};
  let gate: import('./agents/LlmBrain.ts').LlmGate | null = null;
  if (env.ANTHROPIC_API_KEY?.trim() && env.LLM !== '0') {
    try {
      const { LlmBrain, LlmGate } = await import('./agents/LlmBrain.ts');
      const cap = Math.max(0, Math.floor(Number(env.LLM_MAX_CALLS ?? 150)) || 0);
      const interval = Math.max(1, Math.floor(Number(env.LLM_MIN_INTERVAL_TICKS ?? 3)) || 3);
      gate = new LlmGate(cap, interval);
      for (const a of agents) brains[a.agentId] = new LlmBrain(createRuleBrain(a.agentId, brainOptions), { apiKey: env.ANTHROPIC_API_KEY.trim(), warn, gate });
      summary.push(`brains: LlmBrain over RuleBrain (cap ${cap} calls per process, at most one per agent every ${interval} ticks, only with 2+ candidates)`);
    } catch (e) {
      warn(`LlmBrain failed to load (${errMsg(e)}); using RuleBrain.`);
    }
  } else {
    summary.push(env.LLM === '0' ? 'brains: RuleBrain (LLM=0)' : 'brains: RuleBrain (deterministic)');
  }

  const deps: DeskDeps = {
    provider,
    railFactory,
    railName,
    agents,
    deskAddress,
    riskAddress,
    config,
    mode: data,
    scorecard,
    brains,
    brainOptions,
    onchainLinks: cachedOnchainLinks(REPO_ROOT),
    scorecardFeeds,
    llmStats: gate ? () => gate!.stats() : undefined,
  };
  summary.push(`config: evalTicks ${config.evalTicks}, tickMs ${config.tickMs}, pot ${config.realPot} ${config.asset.toUpperCase()}, band ${brainOptions.bandPct}%, rebalance ${brainOptions.rebalancePp} pts, re-entry ${brainOptions.reentryTicks} ticks`);
  return { deps, summary, gate };
}

/** SCORECARD_FEEDS: JSON map of symbol to feed address. Empty or invalid gives no feeds. */
export function parseFeeds(raw: string | undefined, warn: Warn): Record<string, Hex> {
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, Hex> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = v as Hex;
      else warn(`SCORECARD_FEEDS entry ${k} is not an address; skipped.`);
    }
    return out;
  } catch {
    warn('SCORECARD_FEEDS is not valid JSON; the scorecard gets empty feed arrays.');
    return {};
  }
}

/** Records each raw live snapshot (before any synthetic shock) to data/recordings/<date>.jsonl. */
function withRecorder(p: DataProvider, record: (s: MarketSnapshot, f: string) => unknown, warn: Warn): DataProvider {
  return {
    instruments: () => p.instruments(),
    async snapshot() {
      const s = await p.snapshot();
      const file = path.join(REPO_ROOT, 'data', 'recordings', `${new Date(s.ts).toISOString().slice(0, 10)}.jsonl`);
      try {
        await record(s, file);
      } catch (e) {
        warn(`Recording failed: ${errMsg(e)}`);
      }
      return s;
    },
  };
}

export async function createDeskFromEnv(env?: Env): Promise<{ desk: Desk; summary: string[] }> {
  const { deps, summary, gate } = await wire(env ?? loadEnv());
  const desk = new Desk(deps);
  if (gate) gate.onCapReached = (m) => desk.logEvent('warn', m);
  return { desk, summary };
}
