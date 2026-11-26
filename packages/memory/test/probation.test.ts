import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordsCut } from '../src/probation.js';

const cases: [string, string, string, boolean][] = [
  ['capture style, CUT in next sentence', 'Round 1 on the Cutline desk. Agent Momentum (strategy: buys the strongest BNB Chain major). Result: CUT. Reason: daily loss of 9.65% breached the 3% limit. Paper P&L -9.65%.', 'Momentum', true],
  ['prose', 'Momentum was cut in round 3 after breaching max drawdown.', 'Momentum', true],
  ['lowercase name', 'momentum got cut for a rule breach.', 'Momentum', true],
  ['funded only', 'Agent RWA Rotator (strategy: rotates into tokenized gold). Result: FUNDED. Paper P&L +0.40%.', 'RWA Rotator', false],
  ['cut belongs to another agent in a separate line', 'Agent RWA Rotator. Result: FUNDED.\nAgent Momentum. Result: CUT.', 'RWA Rotator', false],
  ['negated', 'Event Trader was not cut and finished funded.', 'Event Trader', false],
  ['negated with gap', 'Event Trader has never been cut.', 'Event Trader', false],
  ['desk name Cutline is not a cut', 'Round 2 on the Cutline desk. Agent Event Trader. Result: FUNDED.', 'Event Trader', false],
  ['cut-off is not a cut', 'Event Trader hit the cut-off for round close.', 'Event Trader', false],
  ['heading section', '# Momentum\n\n- Round 1: funded\n- Round 2: CUT for daily loss\n\n# RWA Rotator\n\n- Round 1: funded', 'Momentum', true],
  ['heading section other agent', '# Momentum\n\n- Round 2: CUT for daily loss\n\n# RWA Rotator\n\n- Round 1: funded', 'RWA Rotator', false],
  ['name only a prefix of another word', 'Momentums were cut.', 'Momentum', false],
  ['decimal point is not a sentence boundary', 'Agent Momentum lost 9.65% in a day. Result: CUT.', 'Momentum', true],
  ['empty', '', 'Momentum', false],
];

for (const [label, text, name, want] of cases) {
  test(`recordsCut: ${label}`, () => assert.equal(recordsCut(text, name), want));
}
