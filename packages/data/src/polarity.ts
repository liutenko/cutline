/**
 * Explicit, reviewable rules that tag a Cournot ranking row as 'adverse' or 'favorable' for crypto risk assets.
 * A row is classified only when its title is clearly about a crypto price or a macro event with an obvious
 * direction. Everything else returns undefined and is dropped by the caller. No guessing.
 */

/** Subjects whose price move we treat as a risk-asset signal. */
export const CRYPTO_SUBJECT = /\b(bitcoin|btc|ethereum|ether|eth|solana|sol|bnb|xrp|dogecoin|doge|crypto(?:currency)?|total crypto market cap)\b/i;

/** Words that mean the price goes DOWN (bad for risk assets). */
export const DOWN_WORDS = /\b(below|dip(?:s)? to|fall(?:s)?|drop(?:s)? to|crash(?:es)?|under|less than|lower than)\b/i;
/** Words that mean the price goes UP (good for risk assets). "reach"/"hit" alone are ambiguous and not used. */
export const UP_WORDS = /\b(above|exceed(?:s)?|over|greater than|higher than|all[- ]time high|new ath|ath)\b/i;

/** Macro events with an obvious direction for risk assets. */
export const MACRO_RULES: { name: string; pattern: RegExp; polarity: 'adverse' | 'favorable' }[] = [
  { name: 'Fed cut', pattern: /\b(fed|fomc|federal reserve)\b.*\b(cut|cuts|decrease|decreases|lower|lowers)\b.*\b(rates?|interest)\b/i, polarity: 'favorable' },
  { name: 'Fed cut (alt order)', pattern: /\b(cut|decrease)\b.*\b(fed|fomc|federal reserve)\b.*\brates?\b/i, polarity: 'favorable' },
  { name: 'Fed hike', pattern: /\b(fed|fomc|federal reserve)\b.*\b(hike|hikes|increase|increases|raise|raises)\b.*\b(rates?|interest)\b/i, polarity: 'adverse' },
  { name: 'US recession', pattern: /\b(us|u\.s\.|united states)\b.*\brecession\b|\brecession\b.*\b(us|u\.s\.|united states)\b/i, polarity: 'adverse' },
];

/** "Hike rates by 0bps" means the Fed holds, which has no obvious direction: never classify it. */
const ZERO_BPS = /\b0\s?bps\b/i;

export function classifyPolarity(title: string): { polarity: 'adverse' | 'favorable'; rule: string } | undefined {
  if (ZERO_BPS.test(title)) return undefined;
  for (const r of MACRO_RULES) if (r.pattern.test(title)) return { polarity: r.polarity, rule: r.name };
  if (CRYPTO_SUBJECT.test(title) && /\bprice\b|\$\s?\d|\bmarket cap\b/i.test(title)) {
    const down = DOWN_WORDS.test(title);
    const up = UP_WORDS.test(title);
    if (down && !up) return { polarity: 'adverse', rule: 'crypto price down' };
    if (up && !down) return { polarity: 'favorable', rule: 'crypto price up' };
  }
  return undefined;
}
