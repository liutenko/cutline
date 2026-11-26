import type { EventRisk as EV } from '../types';
import { clock, dateTime } from '../format';

const VENUES: Record<string, string> = { polymarket: 'Polymarket', kalshi: 'Kalshi', binance: 'Binance', deribit: 'Deribit' };
const niceTitle = (t: string): string => t.replace(/\b(polymarket|kalshi|binance|deribit)\b/gi, (m) => VENUES[m.toLowerCase()] ?? m);
function niceSnippet(title: string, snippet: string): string {
  let s = snippet.trim();
  if (s.toLowerCase().startsWith(title.trim().toLowerCase())) s = s.slice(title.trim().length).replace(/^[\s:,.\-]+/, '');
  return s;
}
const p100 = (n: number | undefined): string => (n === undefined ? 'n/a' : `${(n * 100).toFixed(0)}%`);

export function EventRiskPanel({ events, multiplier }: { events: EV[]; multiplier: number }) {
  const ranking = events.filter((e) => e.origin === 'ranking');
  const assessed = events.filter((e) => e.origin !== 'ranking');
  const advList = assessed.filter((e) => e.polarity === 'adverse').sort((a, b) => b.cournotProbability - a.cournotProbability);
  const sorted = [...advList, ...assessed.filter((e) => e.polarity !== 'adverse')];
  const lead = advList[0];
  const m = Math.round(multiplier * 100);
  return (
    <section className="panel event" aria-label="Event risk">
      <div className="panel-head">
        <h2>Event risk <span className="src">from Cournot</span></h2>
      </div>
      <div className={`multiplier ${m < 100 ? 'cut' : ''}`}>
        <span className="big">{m}%</span>
        <span>Risk budgets at {m}%<br /><span className="muted small formula">{lead ? formula(lead, multiplier) : 'No adverse claim assessed: risk budgets at 100%'}</span></span>
      </div>
      <div className="claims">
        {sorted.length === 0 && <p className="empty">No event claims reported yet.</p>}
        {sorted.map((e, i) => (
          !(i === 0 && lead) ? (
            <article key={e.requestId ?? e.claim} className="claim one" title={`${e.claim} (${e.live ? 'live call' : 'proof cache'}, ${dateTime(e.fetchedAt)})`}>
              <span className="one-claim">&ldquo;{e.claim}&rdquo;</span>
              <span className="one-stats mono">{p100(e.cournotProbability)} vs {p100(e.venuePrice)}, {e.divergence === undefined ? 'n/a' : `${e.divergence > 0 ? '+' : ''}${(e.divergence * 100).toFixed(0)} pts`}</span>
            </article>
          ) : (
          <article key={e.requestId ?? e.claim} className="claim lead">
            <p className="claim-text">&ldquo;{e.claim}&rdquo;</p>
            <p className="small muted meta">{e.polarity === 'adverse' ? 'If true, bad for risk assets' : 'If true, good for risk assets'}{e.venue ? ` · venue: ${e.venue}` : ''}</p>
            <div className="probs">
              <div><span className="label">Cournot</span><span className="num">{p100(e.cournotProbability)}</span></div>
              <div><span className="label">Venue price</span><span className="num">{p100(e.venuePrice)}</span></div>
              <div><span className="label">Divergence</span><span className="num">{e.divergence === undefined ? 'n/a' : `${e.divergence > 0 ? '+' : ''}${(e.divergence * 100).toFixed(0)} pts`}</span></div>
            </div>
            <p className={`provenance ${e.live ? 'live' : 'cache'}`}>
              {e.live ? `Live Cournot call at ${clock(e.fetchedAt)}` : `From proof cache, fetched ${dateTime(e.fetchedAt)}`}
              {e.requestId ? <span className="mono muted"> · {e.requestId}</span> : null}
            </p>
            {e.sources.length > 0 && (
              <ul className="sources">
                {e.sources.map((s, k) => (
                  <li key={k} title={s.snippet ? `${s.title}: ${s.snippet}` : s.title}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{niceTitle(s.title)}</a> : niceTitle(s.title)}{s.snippet && niceSnippet(s.title, s.snippet) && <span className="muted src-snip">: {niceSnippet(s.title, s.snippet)}</span>}</li>
                ))}
              </ul>
            )}
            {i === 0 && e.cournotExplanation && <p className="explain small muted">{e.cournotExplanation}</p>}
          </article>
          )
        ))}
      </div>
      {ranking.length > 0 && (
        <div className="ranking">
          <h3>Where Cournot disagrees with the venues</h3>
          <table>
            <colgroup><col style={{ width: '42%' }} /><col style={{ width: '18%' }} /><col style={{ width: '12%' }} /><col style={{ width: '12%' }} /><col style={{ width: '16%' }} /></colgroup>
            <thead><tr><th>Claim</th><th>Venue</th><th className="r">Cournot</th><th className="r">Venue px</th><th className="r">Gap, pts</th></tr></thead>
            <tbody>
              {ranking.slice(0, 3).map((e) => (
                <tr key={e.marketId ?? e.claim}>
                  <td className="rk-claim" title={e.claim}><span className={`pol ${e.polarity}`}>{e.polarity === 'adverse' ? 'adverse' : 'favorable'}</span>{e.claim}</td>
                  <td className="muted">{(e.venue ?? '-').replace(/ prediction market$/i, '')}</td>
                  <td className="r mono">{p100(e.cournotProbability)}</td>
                  <td className="r mono">{p100(e.venuePrice)}</td>
                  <td className="r mono">{e.divergence === undefined ? 'n/a' : `${e.divergence > 0 ? '+' : ''}${(e.divergence * 100).toFixed(0)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formula(lead: EV, mult: number): string {
  const p = lead.cournotProbability;
  const base = 1 - p;
  const text = `1 - ${p.toFixed(2)} (probability of the lead adverse claim) = ${base.toFixed(2)}`;
  return Math.abs(base - mult) > 0.005 ? `${text}, applied ${mult.toFixed(2)}` : text;
}
