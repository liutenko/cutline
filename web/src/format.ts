export const usd = (n: number, digits = 0): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

export function price(n: number): string {
  if (n >= 1000) return usd(n, 2);
  if (n >= 1) return usd(n, 3);
  return '$' + n.toPrecision(3);
}

export const pct = (n: number, digits = 2, sign = false): string =>
  `${sign && n > 0 ? '+' : ''}${n.toFixed(digits)}%`;

export const signedUsd = (n: number): string => `${n >= 0 ? '+' : '-'}${usd(Math.abs(n), 0)}`;

export const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const dateTime = (ts: number): string =>
  new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const shortHash = (h: string): string => (h.length > 14 ? `${h.slice(0, 8)}...${h.slice(-6)}` : h);

export const amount = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export const money2 = (n: number): string => n.toFixed(2);
export const money3 = (n: number): string => n.toFixed(3);
