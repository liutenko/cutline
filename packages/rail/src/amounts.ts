import { Decimal } from 'decimal.js';
import type { RailParticipant } from '../../../shared/src/types.js';

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Parses a non-negative decimal string. Throws a clear error otherwise. */
export function parseAmount(value: string, label: string): Decimal {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value.trim())) {
    throw new Error(`${label}: "${String(value)}" is not a non-negative decimal string`);
  }
  return new Decimal(value.trim());
}

/** Canonical decimal string: no exponent, no trailing zeros. */
export function fmt(d: Decimal): string {
  return d.toFixed();
}

export function sum(values: Iterable<Decimal>): Decimal {
  let total = new Decimal(0);
  for (const v of values) total = total.plus(v);
  return total;
}

/** Validates the participant list: unique ids and addresses, exactly one desk and one risk. */
export function validateParticipants(participants: RailParticipant[]): void {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error('participants: need at least a desk and a risk participant');
  }
  const ids = new Set<string>();
  const addrs = new Set<string>();
  for (const p of participants) {
    if (!p.id) throw new Error('participants: every participant needs an id');
    if (ids.has(p.id)) throw new Error(`participants: duplicate id "${p.id}"`);
    ids.add(p.id);
    if (!/^0x[0-9a-fA-F]{40}$/.test(p.address)) {
      throw new Error(`participants: "${p.id}" has an invalid address`);
    }
    const a = p.address.toLowerCase();
    if (addrs.has(a)) throw new Error(`participants: duplicate address for "${p.id}"`);
    addrs.add(a);
  }
  const desks = participants.filter((p) => p.role === 'desk');
  const risks = participants.filter((p) => p.role === 'risk');
  if (desks.length !== 1) throw new Error(`participants: need exactly one desk, got ${desks.length}`);
  if (risks.length !== 1) throw new Error(`participants: need exactly one risk manager, got ${risks.length}`);
}

/**
 * Validates a proposed allocation map against the participant set and the conserved total.
 * Missing participants are treated as zero. Returns a complete map with every participant id.
 */
export function normalizeAllocations(
  next: Record<string, string>,
  participantIds: string[],
  total: Decimal,
  maxDecimals?: number,
): Record<string, Decimal> {
  if (!next || typeof next !== 'object') throw new Error('allocations: expected an object of id -> decimal string');
  const known = new Set(participantIds);
  for (const id of Object.keys(next)) {
    if (!known.has(id)) throw new Error(`allocations: "${id}" is not a participant in this session`);
  }
  const out: Record<string, Decimal> = {};
  for (const id of participantIds) {
    const raw = next[id];
    const d = raw === undefined ? new Decimal(0) : parseAmount(raw, `allocations.${id}`);
    if (maxDecimals !== undefined && d.decimalPlaces() > maxDecimals) {
      throw new Error(`allocations.${id}: "${raw}" has more than ${maxDecimals} decimal places`);
    }
    out[id] = d;
  }
  const s = sum(Object.values(out));
  if (!s.equals(total)) {
    throw new Error(`allocations: total ${fmt(s)} does not equal the session total ${fmt(total)}`);
  }
  return out;
}

export function toStrings(m: Record<string, Decimal>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) out[k] = fmt(v);
  return out;
}
