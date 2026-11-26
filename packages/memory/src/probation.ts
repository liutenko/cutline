/**
 * Probation rule, decided in code from the FULL page text (never from the model's wording).
 *
 * A page records a cut for an agent when, for any mention of the agent's name:
 *   (1) SENTENCE WINDOW: the sentence containing the name, or the single sentence right after it
 *       in the same paragraph/line, contains the standalone word "cut" (any case, so "CUT" counts),
 *       not negated. This covers "Agent Momentum (...). Result: CUT." and "Momentum was cut in round 3."
 *   (2) SECTION: a markdown heading contains the name, and any line in that section (up to the next
 *       heading) contains the standalone word "cut", not negated.
 *
 * "cut" must be a whole word: "Cutline", "cuts", "cutoff" do not count, and "cut-off" does not count.
 * Negated forms do not count: "not/never/no/without ... cut" within three words ("was not cut",
 * "never been cut", "no cut on record").
 *
 * Name matching is case-insensitive, whole phrase ("Momentum" will not match "Momentums" but will
 * match "momentum"). Known limitation: a page that interleaves several agents inside one sentence
 * can produce a false positive for an agent named next to another agent's cut. Probation is the
 * conservative outcome in that case.
 */

const CUT_WORD = /\bcut\b(?!-?offs?\b)/gi;
const NEGATED = /\b(?:not|never|no|without|avoided|avoids)\s+(?:[\w'-]+\s+){0,2}$/i;

function hasCut(text: string): boolean {
  CUT_WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CUT_WORD.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATED.test(before)) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameRegex(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.trim())}(?![\\p{L}\\p{N}])`, 'iu');
}

/** Sentences of one line. A period inside a number ("9.65%") is not a boundary: it needs trailing whitespace. */
function sentences(line: string): string[] {
  return line.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

export function recordsCut(pageText: string, agentName: string): boolean {
  if (!agentName.trim()) return false;
  const re = nameRegex(agentName);
  const lines = pageText.split(/\r?\n/);

  // (1) sentence window, per line so a paragraph boundary stops the window
  for (const line of lines) {
    if (/^\s*#{1,6}\s/.test(line)) continue; // headings are handled by the section rule
    const ss = sentences(line);
    for (let i = 0; i < ss.length; i++) {
      if (!re.test(ss[i])) continue;
      if (hasCut(ss[i]) || (i + 1 < ss.length && hasCut(ss[i + 1]))) return true;
    }
  }

  // (2) section under a heading that names the agent
  let inSection = false;
  for (const line of lines) {
    if (/^\s*#{1,6}\s/.test(line)) {
      inSection = re.test(line);
      if (inSection && hasCut(line)) return true;
      continue;
    }
    if (inSection && hasCut(line)) return true;
  }
  return false;
}
