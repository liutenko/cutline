// Rail amounts: decimal strings on the wire, bigint in 6-decimal base units internally.
export const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);

export function toUnits(s: string): bigint {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`Invalid decimal amount: ${s}`);
  const [whole, frac = ''] = t.split('.');
  const f = (frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS);
  return BigInt(whole) * SCALE + BigInt(f);
}

export function fromUnits(u: bigint): string {
  if (u < 0n) throw new Error(`Negative amount: ${u}`);
  const whole = u / SCALE;
  const frac = (u % SCALE).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Float dollars to units, rounded to the nearest unit. Only for P&L deltas. */
export function floatToUnits(x: number): bigint {
  return BigInt(Math.round(x * 10 ** DECIMALS));
}

export function sumUnits(map: Record<string, string>): bigint {
  return Object.values(map).reduce((a, v) => a + toUnits(v), 0n);
}

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

/** Decimals of the Atlas feeds the Scorecard reads (BSC testnet feeds use 18). The one place this scale is set. */
export const SCORECARD_FEED_DECIMALS = 18;

/** Scales a positive float price to an integer with `decimals` places, via its decimal string (no float overflow). */
export function scalePrice(price: number, decimals = SCORECARD_FEED_DECIMALS): bigint {
  if (!(price > 0) || !Number.isFinite(price)) return 0n;
  // Shortest round-trip decimal form (e.g. "60555.0254"); toFixed would add float noise.
  const str = String(price).includes('e') ? price.toFixed(Math.min(decimals, 20)) : String(price);
  const [w, f = ''] = str.split('.');
  return BigInt(w + (f + '0'.repeat(decimals)).slice(0, decimals));
}
