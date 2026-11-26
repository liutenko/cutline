import type { EventRisk } from '../../../shared/src/types.js';

export interface MapInput {
  claim: string;
  marketId: string;
  polarity: 'adverse' | 'favorable';
  /** The complete raw response body of the probability call. */
  body: any;
  requestId?: string;
  fetchedAt: number;
  live: boolean;
}

type Source = EventRisk['sources'][number];

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Evidence from `basis`, exactly as returned. Two shapes exist per the client docs:
 *  - legacy array of { source, summary, time, url }
 *  - structured object (primary_anchor, price_distance, cross_checks[], limitations[])
 * Each entry keeps its own text; nothing is summarised or invented.
 */
export function mapBasis(basis: unknown): Source[] {
  const out: Source[] = [];
  const add = (title: string | undefined, url: string | undefined, snippet: string | undefined) => {
    if (title || url || snippet) out.push({ title: title ?? url ?? 'basis', ...(url ? { url } : {}), ...(snippet ? { snippet } : {}) });
  };
  if (Array.isArray(basis)) {
    for (const b of basis) {
      if (!isObj(b)) continue;
      const time = str(b.time);
      const summary = str(b.summary);
      add(str(b.source), str(b.url), summary && time ? `${summary} (${time})` : summary ?? time);
    }
  } else if (isObj(basis)) {
    for (const [section, v] of Object.entries(basis)) {
      const items = Array.isArray(v) ? v : [v];
      for (const it of items) {
        if (isObj(it)) add(str(it.source) ?? section, str(it.url), str(it.summary) ?? JSON.stringify(it));
        else if (it !== null && it !== undefined) add(section, undefined, String(it));
      }
    }
  }
  return out;
}

/** Maps a successful /probability response body into EventRisk. Fields the response lacks stay undefined. */
export function mapProbabilityResponse(i: MapInput): EventRisk {
  const d = i.body?.data;
  if (!isObj(d)) throw new Error('Cournot response has no data');
  // Per the client docs: if `probability` is an object holding result/basis use those, else the sibling fields.
  const pobj = isObj(d.probability) ? d.probability : undefined;
  const result = pobj?.result ?? d.result;
  let p: number | undefined;
  if (typeof d.probability === 'number') p = d.probability;
  else if (typeof result === 'number') p = result;
  else if (isObj(result) && typeof result.point_estimate === 'number') p = result.point_estimate;
  if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error('Cournot response has no probability');

  const markets: any[] = Array.isArray(d.markets) ? d.markets : [];
  const market = markets.find((m) => String(m?.market_info?.id) === String(i.marketId)) ?? markets[0];
  const venuePrice = typeof market?.market_info?.market_outcome_price === 'number' ? market.market_info.market_outcome_price : undefined;

  const basis = pobj?.basis ?? d.basis;
  const sources = mapBasis(basis);

  // Venue names come from basis entries that quote a venue price; they are the response's own labels.
  const venues = Array.isArray(basis)
    ? [...new Set(basis.filter((b: any) => isObj(b) && /latest (yes )?price/i.test(String(b.summary ?? ''))).map((b: any) => String(b.source)))]
    : [];

  const explanation = str(d.explanation) ?? str(pobj?.explanation) ?? (isObj(result) ? str(result.explanation) : undefined);

  return {
    claim: i.claim,
    ...(venues.length ? { venue: venues.join(', ') } : {}),
    marketId: i.marketId,
    cournotProbability: p,
    ...(venuePrice !== undefined ? { venuePrice, divergence: p - venuePrice } : {}),
    sources,
    ...(explanation ? { cournotExplanation: explanation } : {}),
    ...(i.requestId ? { requestId: i.requestId } : {}),
    fetchedAt: i.fetchedAt,
    live: i.live,
    polarity: i.polarity,
    origin: 'assessment',
  };
}
