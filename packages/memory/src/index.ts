import type { AgentAccount, AgentId } from '../../../shared/src/types.js';
import { LbHttp, LivingBrainError, type FetchLike } from './http.js';
import { agentDocument, originRefFor, type RoundReport } from './document.js';
import { recordsCut } from './probation.js';

export { LivingBrainError } from './http.js';
export { safe } from './safe.js';
export { recordsCut } from './probation.js';
export { agentDocument, originRefFor } from './document.js';
export type { RoundReport, RoundAgentReport } from './document.js';

export const DEFAULT_BASE_URL = 'https://api.livingbrain.com';
export const BRAIN_NAME = 'cutline-desk';
const BRAIN_NAMES = ['cutline', 'cutline-desk'];

export type AgentRecall = NonNullable<AgentAccount['memory']> & {
  /** Pages that matched but are `contested` (two claims disagree). Not used for the probation decision. */
  contested?: { slug: string; title?: string }[];
};

export interface IngestSource {
  id: string;
  originRef: string | null;
  status: 'pending' | 'compiling' | 'completed' | 'failed';
  label?: string;
  lastError?: string | null;
}

interface Brain { id: string; name: string }
interface Profile { focus?: string; directives?: unknown }
interface SearchHit { slug: string; title: string; summary: string; status: string; similarity: number }
interface Page { slug: string; title: string; summary: string; body: string; version: number; status: string }

export interface DeskMemoryOptions {
  fetch?: FetchLike;
  retries?: number;
  backoffMs?: number;
  now?: () => number;
}

/** What the desk wants the brain to pay attention to. Set once per brain (see ensureProfile). */
export const DESK_PROFILE = {
  whoTheyAre: 'The risk desk of Cutline, a prop desk for AI trading agents on BNB Chain.',
  whatTheyDo:
    'The desk evaluates AI trading agents on paper accounts, funds the ones that pass, checks every order with a risk manager, and cuts agents that break a rule.',
  focus:
    'Per agent, per round: agent names, whether the agent was funded or cut, the rule that was breached, paper P&L, number of trades, and rejected orders with the reason. One page per agent is preferred.',
  goals: 'Know each agent track record before the next round so an agent with an earlier cut starts on probation.',
  directives: { flagContradictions: true, surfaceConnections: true, custom: 'Keep agent names exactly as written. A cut is a permanent fact about a round.' },
} as const;

export class DeskMemory {
  private readonly http: LbHttp;
  private readonly now: () => number;
  private brainPromise?: Promise<string>;
  private name?: string;
  private profilePromise?: Promise<void>;

  constructor(
    http: LbHttp,
    private readonly configuredBrainId: string | undefined,
    now: () => number = Date.now,
  ) {
    this.http = http;
    this.now = now;
  }

  /** Brain id from LIVINGBRAIN_BRAIN_ID, else the brain named "cutline-desk" (created if absent). Cached. */
  brainId(): Promise<string> {
    this.brainPromise ??= this.resolveBrain().catch((e) => {
      this.brainPromise = undefined; // allow a later retry
      throw e;
    });
    return this.brainPromise;
  }

  private async resolveBrain(): Promise<string> {
    if (this.configuredBrainId) {
      // UNVERIFIED: GET /v1/brains/{id} returns BrainDto with name (listed in OpenAPI).
      try { this.name = (await this.http.request<Brain>('GET', `/v1/brains/${this.configuredBrainId}`)).name; } catch { /* name is cosmetic */ }
      return this.configuredBrainId;
    }
    // GET /v1/brains -> BrainDto[]
    const brains = await this.http.request<Brain[]>('GET', '/v1/brains');
    const found = brains.find((b) => BRAIN_NAMES.includes(b.name.trim().toLowerCase()));
    if (found) { this.name = found.name; return found.id; }
    // POST /v1/brains { name } -> BrainDto
    const created = await this.http.request<Brain>('POST', '/v1/brains', { body: { name: BRAIN_NAME } });
    this.name = created.name ?? BRAIN_NAME;
    return created.id;
  }

  /** Real name of the brain in use (resolves it first). For memoryStatus.brainName. */
  async brainName(): Promise<string | undefined> {
    await this.brainId();
    return this.name;
  }

  /** Sets the brain profile once. Skipped when a profile with a focus already exists (never overwrites a human edit). */
  private ensureProfile(): Promise<void> {
    this.profilePromise ??= this.setProfileOnce().catch((e) => {
      this.profilePromise = undefined;
      throw e;
    });
    return this.profilePromise;
  }

  private async setProfileOnce(): Promise<void> {
    const id = await this.brainId();
    let existing: Profile | undefined;
    try {
      existing = await this.http.request<Profile>('GET', `/v1/brains/${id}/profile`);
    } catch (e) {
      // UNVERIFIED: a brand-new brain may answer 404 for the profile instead of an empty object.
      if (!(e instanceof LivingBrainError && e.status === 404)) throw e;
    }
    if (existing?.focus && existing.focus.trim()) return;
    // UNVERIFIED: PATCH accepts a partial body with these fields; directives.custom/flagContradictions/surfaceConnections without the other two booleans.
    await this.http.request('PATCH', `/v1/brains/${id}/profile`, { body: DESK_PROFILE });
  }

  async profile(): Promise<Profile> {
    const id = await this.brainId();
    return this.http.request<Profile>('GET', `/v1/brains/${id}/profile`);
  }

  async stats(): Promise<{ pageCount: number; sourceCount: number; connectionCount: number }> {
    const id = await this.brainId();
    return this.http.request('GET', `/v1/brains/${id}/stats`);
  }

  /**
   * Captures one note per agent for the round. Never searches for what it just wrote (capture
   * returns before compilation). The originRef makes a retry update the same capture.
   * Tries every agent, then throws one error listing the failures.
   */
  async rememberRound(report: RoundReport): Promise<IngestSource[]> {
    const id = await this.brainId();
    await this.ensureProfile();
    const out: IngestSource[] = [];
    const failures: string[] = [];
    for (const a of report.agents) {
      const originRef = originRefFor(report.roundId, a.agentId);
      try {
        // POST /v1/brains/{id}/captures -> BrainIngestSourceDto (status "pending")
        // UNVERIFIED: a repeat call with the same originRef returns 201 with the same source (docs say it updates the capture, not duplicates).
        // UNVERIFIED: kind "note" with no bucket and no `source` field is accepted; label is free text.
        const src = await this.http.request<IngestSource>('POST', `/v1/brains/${id}/captures`, {
          body: {
            kind: 'note',
            content: agentDocument(report, a),
            label: `Round ${report.roundId}: ${a.name}`,
            originRef,
          },
        });
        out.push(src);
      } catch (e) {
        failures.push(`${a.agentId}: ${(e as Error).message}`);
      }
    }
    if (failures.length) {
      throw new LivingBrainError(
        `rememberRound(${report.roundId}) failed for ${failures.length} of ${report.agents.length} agents: ${failures.join(' | ')}`,
      );
    }
    return out;
  }

  /** Sources still being compiled (pending or compiling). Use it to show "memory is catching up". */
  async pendingSources(): Promise<IngestSource[]> {
    const a = await this.listSources('pending');
    const b = await this.listSources('compiling');
    return [...a, ...b];
  }

  async listSources(status: IngestSource['status']): Promise<IngestSource[]> {
    const id = await this.brainId();
    // GET /v1/brains/{id}/sources?status=..&limit=.. -> { items, total, limit, offset }
    // UNVERIFIED: limit=100 is within the server maximum.
    const r = await this.http.request<{ items: IngestSource[] }>('GET', `/v1/brains/${id}/sources`, {
      query: { status, limit: 100 },
    });
    return r.items;
  }

  /**
   * Looks up an agent's history: the question as asked plus one rewrite, the best active pages
   * read in full, probation decided by recordsCut() on the full text. Null when nothing relevant.
   */
  async recallAgent(agentId: AgentId, name: string): Promise<AgentRecall | null> {
    const id = await this.brainId();
    const queries = [
      `What is the history of the trading agent ${name} on the Cutline desk? Was it funded or cut?`,
      `${name} agent cut, rule breach, daily loss, rejected orders, paper P&L`, // rewrite
    ];
    const hits = new Map<string, SearchHit>();
    for (const query of queries) {
      // POST /v1/brains/{id}/search { query, topK } -> SearchHit[]  (201)
      const res = await this.http.request<SearchHit[]>('POST', `/v1/brains/${id}/search`, { body: { query, topK: 5 } });
      for (const h of res) {
        const prev = hits.get(h.slug);
        if (!prev || h.similarity > prev.similarity) hits.set(h.slug, h);
      }
    }
    const ranked = [...hits.values()].sort((x, y) => y.similarity - x.similarity);
    const contested = ranked.filter((h) => h.status === 'contested').map((h) => ({ slug: h.slug, title: h.title }));
    const active = ranked.filter((h) => h.status === 'active').slice(0, 4);

    const nameRe = new RegExp(`(?<![\\p{L}\\p{N}])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
    const read: Page[] = [];
    for (const h of active) {
      // GET /v1/brains/{id}/pages/{slug} -> BrainPageDto (body, summary, version, status)
      // UNVERIFIED: reading a page may count as a reference (lastReferencedAt); harmless.
      const p = await this.http.request<Page>('GET', `/v1/brains/${id}/pages/${encodeURIComponent(h.slug)}`);
      if (p.status === 'active' && nameRe.test(`${p.title}\n${p.summary}\n${p.body}`)) read.push(p);
    }
    if (read.length === 0) return null;

    const best = read[0];
    const summary = pickSummary(best, nameRe);
    return {
      source: 'Living Brain',
      summary,
      pages: read.map((p) => ({ slug: p.slug, version: p.version, title: p.title })),
      probation: read.some((p) => recordsCut(`${p.title}\n${p.summary}\n${p.body}`, name)),
      recalledAt: this.now(),
      ...(contested.length ? { contested } : {}),
    };
  }
}

const MAX_SUMMARY = 240;

/** The brain's own words, verbatim: page summary if it names the agent, else the first body sentence that does, else the opening. */
function pickSummary(p: Page, nameRe: RegExp): string {
  const clip = (s: string): string => (s.length <= MAX_SUMMARY ? s : s.slice(0, MAX_SUMMARY - 1).trimEnd() + '…');
  const s = (p.summary ?? '').trim();
  if (s && nameRe.test(s)) return clip(s);
  const sentence = p.body
    .split(/\r?\n/)
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .map((x) => x.trim())
    .find((x) => x && !x.startsWith('#') && nameRe.test(x));
  if (sentence) return clip(sentence);
  return clip(s || p.body.trim());
}

/** Returns null (never throws) when LIVINGBRAIN_API_KEY is empty: the engine then runs without memory. */
export function createDeskMemory(
  env: Record<string, string | undefined>,
  opts: DeskMemoryOptions = {},
): DeskMemory | null {
  const apiKey = env.LIVINGBRAIN_API_KEY?.trim();
  if (!apiKey) return null;
  const subjectId = env.LIVINGBRAIN_SUBJECT_ID?.trim();
  if (!subjectId) {
    console.warn('[memory] LIVINGBRAIN_API_KEY is set but LIVINGBRAIN_SUBJECT_ID is empty: running without memory.');
    return null;
  }
  const http = new LbHttp({
    baseUrl: env.LIVINGBRAIN_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey,
    subjectId,
    fetch: opts.fetch,
    retries: opts.retries,
    backoffMs: opts.backoffMs,
  });
  return new DeskMemory(http, env.LIVINGBRAIN_BRAIN_ID?.trim() || undefined, opts.now);
}
