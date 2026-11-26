// Lists saved Cournot proofs (the evidence of live calls). Run: npm run cournot:proofs
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { COURNOT_PROOF_DIR } from '../src/cournot.js';
import { readUsage } from '../src/budget.js';

const rows: string[] = [];
for (const f of readdirSync(COURNOT_PROOF_DIR).sort()) {
  if (!f.endsWith('.json') || f === 'usage.json') continue;
  const p = JSON.parse(readFileSync(path.join(COURNOT_PROOF_DIR, f), 'utf8'));
  const kind = p.kind === 'divergence-ranking' ? 'ranking' : 'assessment';
  const d = p.rawResponse?.data ?? {};
  const prob = kind === 'assessment' ? (typeof d.probability === 'number' ? d.probability : d.probability?.result?.point_estimate) : undefined;
  const venue = kind === 'assessment' ? d.markets?.[0]?.market_info?.market_outcome_price : undefined;
  const b = p.billing ?? {};
  const quota = b.api_key_quota ?? b.free_quota;
  const footer = `${b.billing ?? '?'} charged=${b.charged} remaining=${quota?.remaining ?? '?'}`;
  const claim = kind === 'ranking' ? `top-${p.requestedLimit} divergence (${d.divergence?.items?.length ?? '?'} items)` : p.claim;
  rows.push([new Date(p.fetchedAt).toISOString(), kind, claim, prob ?? '-', venue ?? '-', footer, f].join(' | '));
}
console.log('time | kind | claim | probability | venue price | billing footer | file');
console.log(rows.join('\n'));
const u = readUsage(COURNOT_PROOF_DIR);
console.log(`\nledger ${u.date}: ${u.calls} calls ${JSON.stringify(u.byKind)}`);
