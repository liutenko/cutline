# Cutline

A prop desk for AI trading agents on BNB Chain.

The cutline is the line an agent must stay above to keep its capital: break a risk rule and it is cut.

Last updated: 2026-11-26. Built for the BNB Bangkok hackathon (Developer Track, CoinMarketCap x Atlas, Cournot).

## What it is

Agents are evaluated on paper accounts at live prices, funded with real capital, checked by a risk manager on every order, and cut when they break a rule. Profit is paid out in one settlement, and each agent gets an on-chain track record that includes how often it was cut. Any capital owner can run a desk with its own money: the rules are code, and the desk is software.

**The trades are paper trades.** Fills happen at live CoinMarketCap marks, and each paper fill pays an estimated slippage plus a 0.25% pool fee. The data, the risk decisions, the capital, the cut-off, the payout and the scorecard are real, with the status notes in the next section. This is an independent hackathon project. Using a sponsor's data or a settlement rail does not mean any company is launching or endorsing it. Nothing here is investment advice or an offer to anyone to provide capital.

## What is real and what is simulated

| Part | Status |
|---|---|
| Fills | Simulated. Paper trades at live marks, with estimated slippage and a 0.25% pool fee |
| Market data | Real. CoinMarketCap Pro API, called live from the server; calls logged in `data/proofs/cmc/calls.jsonl` |
| Price check | Real. Marks are checked against the Atlas on-chain feed on BNB Chain mainnet (BNB, ETH, BTCB, CAKE, TSLAB) |
| Event risk | Real. Two Cournot calls with raw responses saved in `data/proofs/cournot/` |
| Risk decisions | Real. Six checks on every order, in `packages/engine/src/risk.ts` |
| Cut-off | Real. Positions closed at mark and the allocation goes back to the desk when a limit is breached |
| Capital and payout | Real code path. Default rail is a local ledger. The Yellow rail passes its tests, but the funded flow has not been run end to end yet: **pending** |
| Scorecard | Real. Deployed on BSC testnet; one round from a live-data run is written on-chain (see "Deployed contracts") |
| Atlas reads inside the Scorecard (testnet) | Real. The contract read the three Atlas testnet feeds on-chain at round close (`readOk` true in all three price stamps) |

## How it works

```
  CoinMarketCap Pro API      Atlas feeds (BNB Chain)      Cournot Oracle Skill
  quotes, DEX liquidity,     on-chain price per symbol    probability + sources
  fear and greed                       |                          |
          \                            |                          /
           +------------> packages/data (live | replay | dev) <--+
                                       |  market snapshot
                                       v
 3 agents --orders--> packages/engine: risk manager (6 checks) --> paper broker
 (momentum, rwa,           |   approve / reject, cut on breach        |
  event)                   |                                          v
                           |                                   paper accounts
                           +--> packages/rail: session, reallocate, close
                           |      (local ledger, or Yellow Network Protocol)
                           +--> contracts: Scorecard on BNB Chain (round close)
                           +--> HTTP + SSE :8787 --> web dashboard :5173
```

1. **Apply.** Three agents each get a $25,000 paper account: `momentum` (BNB majors), `rwa` (tokenized gold and stock) and `event` (trades Cournot's view against prediction-market prices).
2. **Evaluate.** An agent trades paper positions at live prices. After `EVAL_TICKS` ticks (default 6) it is funded if it made at least 2 fills, did not breach a limit, and its paper P&L after costs is not below -0.5% of the account (config defaults in `packages/engine/src/config.ts`).
3. **Fund.** The desk allocates 3 USDT per agent out of a 10 USDT pot. The real allocation tracks the paper account in proportion.
4. **Check every order.** The risk manager runs six checks. A rejected order never fills.

   | Check | Source | Rule |
   |---|---|---|
   | agent-status | Desk | a cut agent cannot trade |
   | liquidity | CoinMarketCap | order is at most 2% of the symbol's BNB Chain DEX liquidity |
   | price-agreement | Atlas | CoinMarketCap and Atlas marks within 50 bps; one source is accepted only for major and RWA instruments; disagreement fails; a stale Atlas price (older than 3,600 s by default) counts as one source |
   | event-budget | Cournot | gross exposure after the order is at most equity x event multiplier |
   | exposure | Desk | spot only: buys covered by cash, no shorts, no leverage |
   | concentration | Desk | one symbol is at most 40% of equity |

5. **Cut.** An agent that loses 3% in a day or 6% from its peak is cut: positions are closed at mark and the real allocation goes back to the desk.
6. **Pay out and record.** At round close each funded agent gets 80% of its real profit. The desk keeps the rest and all principal. Results are written to the Scorecard contract.

## Sponsor technology

| Technology | How it is used | Integration code |
|---|---|---|
| BNB Chain | All instruments trade on BNB Chain (BNB, CAKE, BTCB, ETH, tokenized gold XAUT and XAUM, tokenized Tesla stock TSLAB, and one thin token MTHT used to show the liquidity check). The Scorecard contract targets BSC testnet (chain 97). Atlas feeds are read from BNB Chain mainnet | `packages/data/src/instruments.ts`, `contracts/contracts/Scorecard.sol`, `contracts/src/chains.ts` |
| CoinMarketCap | Pro API: prices, BNB Chain DEX liquidity and volume, fear and greed. The key stays server-side. Every call is logged | `packages/data/src/cmc.ts`, `packages/data/src/provider.ts` |
| Atlas | On-chain SingleFeed price feeds, read every tick for BNB, ETH, BTCB, CAKE and TSLAB. A second set of Atlas feeds on BSC testnet (BNB, BTC, ETH) is stamped by the Scorecard at round close | `packages/data/src/atlas.ts`, `packages/engine/src/risk.ts`, `contracts/contracts/Scorecard.sol` |
| Cournot | Official Cournot Intelligence Oracle Skill client, vendored at a pinned commit. Sets the event-risk multiplier and the event agent's regime | `packages/data/src/cournot.ts`, `packages/data/src/divergence.ts`, `packages/engine/src/risk.ts` |
| Yellow Network Protocol | Settlement runs on Yellow Network Protocol: capital sits in a session, reallocations are off-chain, and nothing moves without both the desk's and the risk manager's signatures (public SDK `@yellow-org/sdk`) | `packages/rail/src/yellow.ts`, `packages/rail/src/index.ts` |

## Quick start

Requires Node 22 or newer (the vendored Cournot client needs 22.20 or newer). Each directory is its own npm project, so install in each one you use.

```bash
cd packages/data   && npm install
cd ../engine       && npm install
cd ../rail         && npm install
cd ../../contracts && npm install
cd ../web          && npm install
```

Copy `.env.example` to `.env` at the repo root and fill it in (see the table below). Use test keys only. Never commit `.env`.

**Dev mode.** Simulated prices, local rail, no keys needed. Marked "DEV SIMULATION" on the dashboard.

```bash
cd packages/engine
npm run demo:dev
```

**Live mode.** Real CoinMarketCap, Atlas and Cournot data. Needs `CMC_API_KEY`, the five participant keys, and an Atlas feed source (the mainnet feed addresses are built in). Each snapshot is appended to `data/recordings/<date>.jsonl`.

```bash
cd packages/engine
DATA=live RAIL=local npm start
```

Cournot is read from the saved proofs unless `COURNOT_MAX_CALLS` allows a billable live call.

**Replay mode.** Plays a recorded file in a loop. `TICK_MS` sets the speed. The dashboard shows "Replay of live data recorded <time>". Record a file with `npm run record` in `packages/data` (one snapshot per minute), or use any `data/recordings/*.jsonl` file you have.

```bash
cd packages/engine
DATA=replay REPLAY_FILE=data/recordings/2026-11-26.jsonl TICK_MS=1500 RAIL=local npm start
```

**Dashboard.**

```bash
cd web
npm run dev          # http://localhost:5173, talks to the engine on :8787
```

Set `VITE_ENGINE_URL` if the engine runs elsewhere. Open `http://localhost:5173/?mock=1` for a labelled mock feed with no engine. Press "Demo controls", then Start. The engine API is `GET /api/state`, `GET /api/events` (SSE) and `POST /api/control`. Set `AUTOSTART=1` to start the round at launch.

**Yellow rail (optional).** `RAIL=yellow-sandbox` uses the Yellow sandbox node. `RAIL=yellow-mainnet` moves real funds on BNB Chain and refuses to open without an explicit confirmation variable; the manual funding steps are in `packages/rail/scripts/fund-mainnet.md`.

**Scorecard deployment.** `cd contracts && npm run deploy:testnet`, then set `SCORECARD_ADDRESS` in `.env`.

## Configuration

Names and meaning only. Values live in `.env`, which is never committed.

| Variable | Meaning |
|---|---|
| `DATA` | `live` (default), `replay` or `dev` |
| `RAIL` | `local` (default), `yellow-sandbox` or `yellow-mainnet` |
| `PORT` | Engine port, default 8787 |
| `AUTOSTART` | `1` starts the round at launch |
| `TICK_MS`, `EVAL_TICKS` | Tick length and ticks an agent must survive before funding |
| `REAL_POT`, `REAL_ALLOCATION`, `ASSET` | Pot size, allocation per agent, `usdt` or `usdc` |
| `POOL_FEE_PCT`, `EVAL_MIN_TRADES`, `EVAL_MIN_PNL_PCT` | Paper pool fee and evaluation bar |
| `REPLAY_FILE` | Recording to play in replay mode |
| `RECORD` | `0` turns off snapshot recording in live mode |
| `DEV_SEED` | Seed for the dev simulation |
| `CMC_API_KEY` | CoinMarketCap Pro API key (server-side only) |
| `ATLAS_FEEDS` | Optional override of the Atlas feed config (chain id, RPC, addresses) |
| `ATLAS_MAX_AGE_SEC` | Age after which an Atlas price counts as stale |
| `PRICE_TOLERANCE_BPS` | Price tolerance for the recorder script |
| `COURNOT_API_KEY`, `COURNOT_MAX_CALLS`, `COURNOT_CACHE_TTL_MS` | Cournot key for paid calls, live call budget per process (default 0, cache only), proof cache lifetime |
| `ANTHROPIC_API_KEY`, `LLM` | Optional: lets Claude choose among rule candidates; `LLM=0` turns it off |
| `DESK_KEY`, `RISK_KEY`, `AGENT_MOMENTUM_KEY`, `AGENT_RWA_KEY`, `AGENT_EVENT_KEY` | Test keys for the desk, the risk manager and the three agents |
| `DESK_KEY_MAINNET` | Optional separate desk key for the mainnet rail (the same `_MAINNET` suffix works for the other keys) |
| `YELLOW_WS_SANDBOX`, `YELLOW_WS_MAINNET` | Yellow node endpoints |
| `YELLOW_MAINNET_CONFIRM` | Explicit confirmation needed before the mainnet rail commits real funds |
| `BSC_TESTNET_RPC`, `BSC_MAINNET_RPC` | BNB Chain RPC endpoints |
| `SCORECARD_ADDRESS`, `SCORECARD_NETWORK` | Deployed Scorecard and its network (`bscTestnet` default, or `bsc`) |
| `SCORECARD_FEEDS` | JSON map of symbol to the Atlas feed the Scorecard stamps at close |
| `BAND_PCT`, `BAND_PCT_RWA`, `REBALANCE_PP`, `REENTRY_TICKS` | Agent rule tuning |
| `VITE_ENGINE_URL`, `VITE_PRODUCT_NAME`, `VITE_PRODUCT_TAGLINE` | Dashboard build settings |

## Tests

Run on 2026-11-26. All pass.

| Package | Command | Result |
|---|---|---|
| Engine | `cd packages/engine && npm test` | 31 passing |
| Data | `cd packages/data && npm run test:offline` | 14 passing |
| Rail | `cd packages/rail && npm test` | 17 passing |
| Contracts | `cd contracts && npx hardhat test` | 7 passing |

Live tests (`npm run test:live` in `packages/data` and `packages/rail`) call external services and are not part of the counts above.

## Cournot Integration

**1. What the project is.** A prop desk for AI trading agents on BNB Chain. Cournot supplies the event-risk input that makes the desk's limits move before a loss, not after.

**2. Where and how it calls Cournot.** Through the official Cournot Intelligence Oracle Skill client, vendored at `packages/data/vendor/cournot-skills` at a pinned commit and run by `packages/data/src/cournot.ts` (probability of one claim) and `packages/data/src/divergence.ts` (the divergence ranking). Each call's raw response is saved under `data/proofs/cournot/`. Probabilities are never mocked or hardcoded. A call is made only when no proof is newer than the cache lifetime and the live call budget allows it.

**3. How the probability drives a decision.** The claim is "Bitcoin price below $55,000 at any time before 2027-01-01 05:00 UTC", tagged adverse for risk assets by our configuration. Cournot returned a probability of 0.4862, with a venue price of 0.4862. The engine computes `multiplier = clamp(1 - adverse probability, 0.25, 1)`, which is 1 - 0.4862 = 0.5138, rounded to 0.51. The multiplier scales every agent's risk budget: gross exposure after an order must stay within equity x 100% x 0.51, otherwise the `event-budget` check rejects the order. If any claim shows a gap of 0.10 or more between Cournot and its venue, the multiplier is multiplied by 0.8 again (`eventMultiplier` in `packages/engine/src/risk.ts`). The second call, the divergence ranking, returned 100 rows; the polarity rules in `packages/data/src/polarity.ts` classify 13 of them as clearly adverse (10) or favorable (3) for crypto. These rows give the `event` agent its regime (risk-off, trend or range) and appear in the dashboard. They do not change the multiplier, because they carry no per-claim evidence.

**4. Where users see the claim and evidence.** The "Event risk, from Cournot" panel on the dashboard (`web/src/components/EventRisk.tsx`) shows the exact claim, Cournot's probability, the venue price, the divergence, the sources as returned, and whether the call was live or read from the proof cache. The panel header shows the current multiplier (risk budgets at 51%). Each order on the order tape carries its six checks, including `event-budget` with the numbers. The engine also emits a `budget` event, with a sentence naming the claim and probability, whenever the multiplier changes (`GET /api/events`).

**5. Proof of a successful call.**

| Proof | File | Key values |
|---|---|---|
| Assessment | `data/proofs/cournot/20261126T062318Z-bitcoin-price-below-55-000-at-any-time-before-2027-01-01-05-.json` | HTTP 200, `code` 0 "Success", probability 0.4862, market id 1341, five sources (polymarket, kalshi, binance, venues, deribit), fetched 2026-11-26 06:23 UTC |
| Divergence ranking | `data/proofs/cournot/20261126T062932Z-divergence-ranking.json` | HTTP 200, 100 rows requested and returned |

Billing footer of the assessment, as returned: `billing: "free_quota"`, `charged: false`, `free_quota: { total: 3, used: 1, remaining: 2 }`, `x402: null`. The footer of the ranking call shows `used: 2, remaining: 1`. The caller IP is redacted in both files. The response carried no separate request ID, so the saved raw response, its timestamp and the client commit (`6484146d8a9414f36233087b13f7ed3f4577482a`) are the proof of the call.

## CoinMarketCap and Atlas

**CoinMarketCap Pro API** (server-side, key never in the frontend or the repo). Every call is appended to `data/proofs/cmc/calls.jsonl` with endpoint, parameters, HTTP status and credit count.

| Endpoint | Why |
|---|---|
| `/v3/cryptocurrency/quotes/latest` | The mark for each instrument, plus 1h and 24h change for the momentum agent |
| `/v3/fear-and-greed/latest` | Input to the `rwa` agent's rotation |
| `/v1/dex/token` (platform BSC) | BNB Chain DEX liquidity and 24h volume. Caps each order at 2% of liquidity and sets the estimated slippage on paper fills |

**Atlas on-chain feeds.** Atlas draws on CoinMarketCap pricing data, so we do not present it as an independent source. Marks are checked against the Atlas on-chain feed: a mark where the two prices differ by more than 50 bps, or a feed that is stale, is handled by the `price-agreement` check.

| Feed set | Chain | Used for |
|---|---|---|
| SingleFeed for BNB, CAKE, BTCB, ETH, TSLAB (addresses in `packages/data/src/instruments.ts`) | BNB Chain mainnet | Read by the engine every tick for the price check. XAUT, XAUM and MTHT have no Atlas feed, so they are priced by CoinMarketCap alone |
| Feeds for BNB, BTC, ETH (names in `SCORECARD_FEEDS`) | BSC testnet | Read on-chain by the Scorecard at round close and stamped next to the engine's off-chain price. Addresses: BNB/USD `0x3957d289ee9C38272377786787ea34F9dd29788D`, BTC/USD `0x83B2F2c20df36F166cF5b3f017204cbB7BABcAD0`, ETH/USD `0x35369dEcD8c662954B3D24acc2A862C708A34fD2`. In the first round written, BNB read 554.83 on-chain against 554.69 off-chain |

## Deployed contracts

Operator (desk test wallet): `0x8853e3739f9Aa1d787fdBc3876Ffe13D49CDbA1E`. Explorer: https://testnet.bscscan.com.

| Item | Network | Address or transaction | Link |
|---|---|---|---|
| Scorecard contract | BSC testnet (97) | `0x6fb61263bbc19b10eb1a60ade0ea825769e26b42` | [https://testnet.bscscan.com/address/0x6fb61263bbc19b10eb1a60ade0ea825769e26b42](https://testnet.bscscan.com/address/0x6fb61263bbc19b10eb1a60ade0ea825769e26b42) |
| Deploy transaction | BSC testnet (97) | `0x4036ff8f874fc929bf37b8fec43ee8b83463dd3a7f1a4c9e5a264fc108f00036` | [https://testnet.bscscan.com/tx/0x4036ff8f874fc929bf37b8fec43ee8b83463dd3a7f1a4c9e5a264fc108f00036](https://testnet.bscscan.com/tx/0x4036ff8f874fc929bf37b8fec43ee8b83463dd3a7f1a4c9e5a264fc108f00036) |
| `closeRound` transaction (round from a live-data run: success, 348,760 gas, 7 logs: 3 AgentResult, 3 PriceStamp, 1 RoundClosed) | BSC testnet (97) | `0x767a318e8499d455df798daeae2cbe0a92985c8244c06f33931efcc1f1ab7fb4` | [https://testnet.bscscan.com/tx/0x767a318e8499d455df798daeae2cbe0a92985c8244c06f33931efcc1f1ab7fb4](https://testnet.bscscan.com/tx/0x767a318e8499d455df798daeae2cbe0a92985c8244c06f33931efcc1f1ab7fb4) |
| Yellow deposit and payout transactions (if the mainnet rail is run) | BNB Chain mainnet (56) | PENDING | PENDING |

## Roadmap

1. **Hackathon build.** Three agents, six checks, paper fills with costs, one settlement, Scorecard contract.
2. **Next 90 days.** Open evaluation as an agent skill, live execution on BNB Chain DEXs, and a first desk run by a sponsor with its own money.
3. **Agent sources (roadmap, not built).** Agents built with BNB Agent Studio or any framework would apply to the desk through the same order interface.
4. **Later.** More desks sharing one scorecard standard, and a licensed structure before any outside capital.

## How this becomes a business

1. A desk is software. One capital owner (an exchange, a chain foundation, a DEX, a tokenized-asset issuer, a treasury) runs a desk with its own money. We supply the evaluation, the risk manager, the cut, the settlement and the scorecard.
2. No public pool. We do not take deposits from the public. Outside capital means another capital owner running its own desk, or later a licensed structure.
3. The desk bears trading losses, capped by code at the drawdown limit per agent. The builder risks only the evaluation fee.
4. The fee is a screening price, not the profit engine. It is set so that a coin-flipping agent loses money.
5. The split slides. 80 percent to the agent applies to the small entry tier. As allocations grow, more of the profit goes to the capital owner.

Where this sits: Kraken Prop has no API and its orders are placed by hand. Propr accepts agents, on Hyperliquid perps. BNB Chain has agent tooling and trading contests, and a prize pool is spent once. This desk is the capital step for BNB Chain, with a track record that records risk as well as profit.

## Limitations and honesty notes

- Fills are paper. The desk is the counterparty to paper profit and pays winners from its own pot. Live execution on DEXs is not built.
- The default settlement rail is a local ledger. The Yellow rail is implemented and tested, and the quorum rule (desk and risk manager must both sign) was checked against the Yellow sandbox node. The funded flow has not been run end to end: **pending**.
- Atlas and CoinMarketCap are not independent. Atlas draws on CoinMarketCap pricing, so the check catches stale or broken feeds and mark errors, not a shared upstream error.
- The Scorecard is on testnet only. The round written so far came from a run on live data with paper trades.
- The evaluation bar is low so a round fits in a demo (6 ticks, 2 fills, P&L not below -0.5%). A production bar would add a profit target, a minimum number of trades and a minimum number of days.
- Event risk comes from one fully assessed claim. Cournot's free quota for this project's network address is nearly used (one call left as of the saved proofs). More calls need a paid key.
- The stress-test control applies a labelled synthetic price shock. It is a demo tool and is shown as simulated.
- Nothing here is investment advice or an offer of capital.

## License

MIT. See `LICENSE`.
