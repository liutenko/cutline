// Test fixtures only.
import type { AgentAccount, EventRisk, Instrument, MarketSnapshot, Order } from '../../../shared/src/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { newAccount } from '../src/broker.ts';

export const config = { ...DEFAULT_CONFIG };

export const instruments: Instrument[] = [
  { symbol: 'BNB', name: 'BNB', cmcId: 1839, kind: 'major' },
  { symbol: 'PAXG', name: 'PAX Gold', cmcId: 4705, kind: 'rwa' },
  { symbol: 'THIN', name: 'Thin', cmcId: 1, kind: 'thin' },
];

export function snap(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    ts: 1000,
    marks: {
      BNB: { symbol: 'BNB', cmcPrice: 900, cmcTs: 1000, atlasPrice: 900.5, deviationBps: 5.6, agreement: 'both', pctChange1h: 0.5, pctChange24h: 2 },
      PAXG: { symbol: 'PAXG', cmcPrice: 2650, cmcTs: 1000, agreement: 'single', pctChange1h: 0.1, pctChange24h: 0.3 },
      THIN: { symbol: 'THIN', cmcPrice: 0.04, cmcTs: 1000, agreement: 'single' },
    },
    liquidity: {
      BNB: { symbol: 'BNB', dexLiquidityUsd: 40_000_000, dexVolume24hUsd: 1e7, source: 'test', ts: 1000 },
      PAXG: { symbol: 'PAXG', dexLiquidityUsd: 5_000_000, dexVolume24hUsd: 1e6, source: 'test', ts: 1000 },
      THIN: { symbol: 'THIN', dexLiquidityUsd: 150_000, dexVolume24hUsd: 1e4, source: 'test', ts: 1000 },
    },
    eventRisk: [],
    fearGreed: 50,
    mode: 'dev',
    ...over,
  };
}

export function account(over: Partial<AgentAccount> = {}): AgentAccount {
  return { ...newAccount({ agentId: 'momentum', name: 'Momentum', strategy: 'test', address: '0x0000000000000000000000000000000000000001' }, config), ...over };
}

export function order(over: Partial<Order> = {}): Order {
  return { id: 'o1', agentId: 'momentum', symbol: 'BNB', side: 'buy', notionalUsd: 5000, rationale: 'test', ts: 1000, ...over };
}

export function ev(over: Partial<EventRisk> = {}): EventRisk {
  return { claim: 'X happens', cournotProbability: 0.3, sources: [], fetchedAt: 0, live: false, polarity: 'adverse', ...over };
}

/** Real Cournot rows as returned by the live provider on 2026-11-26 (test fixture only). */
export const REAL_EVENTS: EventRisk[] = [
  { claim: 'Bitcoin price below $55,000 at any time before 2027-01-01 05:00 UTC', cournotProbability: 0.4862, venuePrice: 0.4862, divergence: 0, sources: [], fetchedAt: 0, live: false, polarity: 'adverse', origin: 'assessment' },
  { claim: 'Will Bitcoin exceed $85,000 before Jan 1, 2027?', cournotProbability: 0.006116, venuePrice: 0.07, divergence: -0.063884, sources: [], fetchedAt: 0, live: false, polarity: 'favorable', origin: 'ranking' },
  { claim: 'Will Ethereum exceed $2,500 by Nov 30, 2026?', cournotProbability: 0.00758, venuePrice: 0.06, divergence: -0.05242, sources: [], fetchedAt: 0, live: false, polarity: 'favorable', origin: 'ranking' },
  { claim: 'Will Bitcoin exceed $95,000 by Nov 30, 2026?', cournotProbability: 0.000567, venuePrice: 0.05, divergence: -0.049433, sources: [], fetchedAt: 0, live: false, polarity: 'favorable', origin: 'ranking' },
  { claim: 'Will BTC trimmed mean be below $50000.00 by 11:59 PM ET on Nov 30, 2026?', cournotProbability: 0.034563, venuePrice: 0.08, divergence: -0.045437, sources: [], fetchedAt: 0, live: false, polarity: 'adverse', origin: 'ranking' },
  { claim: 'Will Bitcoin be below $45000.00 by Jan 1, 2027 at 12:00am ET?', cournotProbability: 0.124278, venuePrice: 0.15, divergence: -0.025722, sources: [], fetchedAt: 0, live: false, polarity: 'adverse', origin: 'ranking' },
];

/** The real rows with the divergence of one polarity mirrored (Cournot above the venue instead of below). */
export function mirrored(polarity: 'favorable' | 'adverse'): EventRisk[] {
  return REAL_EVENTS.map((e) => (e.polarity === polarity && e.origin === 'ranking'
    ? { ...e, cournotProbability: e.venuePrice! - e.divergence!, divergence: -e.divergence! }
    : e));
}
