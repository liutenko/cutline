# Cutline: build spec

A prop desk for AI trading agents on BNB Chain. Hackathon build, deadline 27 Nov 2026 09:00 Bangkok. Pitch: `../PITCH.md`. Sponsor rules: `../BRIEF.md`.

## Ground rules for every worker
- You own ONE directory (named in your brief). Do not create or edit files outside it, except `data/proofs/` where your brief says so.
- `shared/src/types.ts` is the contract. Import it by relative path. Do not redefine or edit it. If it is missing something, finish with a local workaround and report it.
- Each directory is an independent npm project (own `package.json`, own `node_modules`). No workspace. Run TypeScript with `tsx`. ESM (`"type": "module"`), Node 22, strict TS.
- Read config from the repo-root `.env` (load with `dotenv` using an explicit path). Never edit `.env`, never print or commit key values. Report any new variable you need.
- Do not run `git add` or `git commit`. The planner commits.
- No mocked or hardcoded data in a live code path. Fixtures are for tests only and live under `test/`.
- No real-money transactions. Mainnet code paths may exist, but you never run them. Testnets only.
- Tests: `node --test` through tsx (`tsx --test`). Keep them fast and offline unless a test is named `*.live.test.ts`.
- Finish with a short report: what works (and how you verified it), what does not, exact commands to run, anything the planner must decide.
- Text style in user-facing copy and docs: plain English, no em dashes, no emoji, no hype words.

## What the product does
1. Three AI trading agents apply to the desk. Each gets a $25,000 paper account.
2. Evaluation: an agent trades paper positions at live prices. After `evalTicks` ticks it is funded on the first tick where it has at least `evalMinTrades` fills (default 2), no breach, and paper P&L after costs at or above `evalMinPnlPct` (default -0.5%). Paper fills pay estimated slippage (2 x notional / DEX liquidity) plus a 0.25% pool fee.
3. Funded: the desk moves real capital to the agent on the settlement rail (default "3" USDT out of a "10" pot). Paper trading continues; the real allocation tracks the paper account proportionally.
4. Every order passes the risk manager first (checks below). Rejected orders never fill.
5. An agent that breaches the daily loss limit (3%) or max drawdown (6% from peak) is cut: positions closed at mark, real allocation returned to the desk.
6. Round close: the rail pays out. Each funded agent gets `profitSplitAgent` (80%) of its real profit; the desk keeps the rest and all principal. Results are written to the Scorecard contract on BNB Chain.

Real allocation math: `scale = realAllocationPerAgent / paperAccountUsd`. An agent's real equity is `paperEquity * scale`. Reallocation on the rail happens when a funded agent's real equity drifts by more than 0.01 from its rail allocation, at cut, and at close. The desk is the counterparty for all paper P&L.

## Risk manager checks (pure functions, engine)
| Check | Source | Rule |
|---|---|---|
| agent-status | Desk | status must not be `cut` |
| liquidity | CoinMarketCap | order notional <= `maxOrderPctOfLiquidity`% of the symbol's BNB Chain DEX liquidity |
| price-agreement | Atlas | the mark is checked against the Atlas on-chain feed (Atlas draws on CoinMarketCap pricing data, so this is a consistency check, not a second independent source): `agreement` must be `both`; `single` passes only for `major` and `rwa` instruments and the detail must say "single source"; `disagree` fails |
| event-budget | Cournot | gross exposure after the order <= `equity * baseRiskBudgetPct% * eventMultiplier` |
| exposure | Desk | buys cannot exceed cash (spot only, no shorts, no leverage) |
| concentration | Desk | one symbol <= `maxConcentrationPct`% of equity after the order |

`eventMultiplier` (applies to all agents): for each `EventRisk`, `adverseProb = polarity=='adverse' ? p : 1-p` where `p = cournotProbability`. Take the highest `adverseProb` across events. `multiplier = clamp(1 - adverseProb, minEventMultiplier, 1)`. Additionally, if `|divergence| >= 0.10` on any event, multiply by 0.8 (the market and Cournot disagree, so uncertainty is high). Emit a `budget` event whenever the multiplier changes, with a sentence naming the claim and the probability.

## Agents
Each agent has its own key and its own module. A `Brain` interface decides orders from `(snapshot, account)`.
- `momentum`: majors. Buys the instrument with the best 1h and 24h change when both are positive; exits on reversal.
- `rwa`: tokenized real-world assets on BNB Chain (tokenized gold XAUT and XAUM, tokenized Tesla stock TSLAB). Rotates into RWA when fear and greed is low or event risk is high, back to cash otherwise.
- `event`: trades the regime implied by Cournot's divergence ranking. upGap and downGap are the mean divergence (Cournot minus venue) over favorable and adverse claims. risk-off (downGap >= +0.03): cut to cash. trend (upGap >= +0.03): add BNB. range (both <= -0.02, the venues overprice both tails): mean reversion on BNB. Otherwise hold.
- Rogue mode (demo control): the agent submits an oversized order in a `thin` instrument, then keeps retrying larger sizes. The risk manager must block these.
- `RuleBrain` is deterministic and is the default. `LlmBrain` (optional, only when `ANTHROPIC_API_KEY` is set) asks Claude to choose among the rule candidates and write the one-sentence rationale.

## Packages
| Directory | Owner | Purpose |
|---|---|---|
| `shared/` | planner | types only |
| `packages/data/` | data worker | CoinMarketCap, Atlas and Cournot adapters; live provider, recorder, replay provider |
| `packages/rail/` | rail worker | `LocalRail`, `YellowRail` |
| `packages/engine/` | engine worker | risk manager, paper broker, agents, desk loop, HTTP and SSE server |
| `contracts/` | contracts worker | `Scorecard.sol`, tests, deploy script, TS client |
| `web/` | dashboard worker | the demo dashboard |

## Interfaces between packages
- `packages/data/src/index.ts` exports `createLiveProvider(opts): DataProvider`, `createReplayProvider(file): DataProvider`, `recordSnapshot(snapshot, file)`, and `INSTRUMENTS`.
- `packages/rail/src/index.ts` exports `createRail(name: RailName, env): SettlementRail`.
- `contracts/src/client.ts` exports `createScorecardClient(env)` with `registerAgents(...)`, `closeRound(...) : Promise<ScorecardTx>`, `getRecord(agentId)`.
- `packages/engine/src/server.ts` serves on `PORT` (default 8787):
  - `GET /api/state` -> `DeskState`
  - `GET /api/events` -> SSE stream, each message is one JSON `DeskEvent`
  - `POST /api/control` with a `ControlAction` body -> `{ ok: true }`
  - CORS open for local dev.

## Modes
- `live`: real CoinMarketCap, Atlas and Cournot calls every tick (respecting rate limits and the Cournot call budget). Every snapshot is appended to `data/recordings/<date>.jsonl`.
- `replay`: plays a recorded file at a configurable speed for the demo time-lapse. The dashboard must show "Replay of live data recorded <time>".
- Stress test: a `shock` control applies a labeled synthetic price change to one symbol's marks (`synthetic: true`). The dashboard must label it as simulated.

## Honesty rules (these are judging requirements)
- Cournot: probabilities are never mocked or hardcoded. Each one traces to a saved raw response in `data/proofs/cournot/`. The UI shows the exact claim, the probability, the venue price and the sources as returned.
- CoinMarketCap: at least one live Pro API call in the core loop; the key stays server-side.
- Trades are paper trades and the UI says so. Capital, cut-off, payout and scorecard are real.
- Yellow: credited once as the settlement rail ("Settlement runs on Yellow Network Protocol"). Never "trustless". Do not use the words Nitrolite or Clearnet in any user-facing text.
