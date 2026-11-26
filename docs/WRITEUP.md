# Write-up: CoinMarketCap x Atlas challenge

Last updated: 2026-11-26

## Problem and audience

BNB Chain has agent tooling and trading contests, but a winning agent has nowhere to go for capital, and capital cannot tell a good agent from a lucky one. Human traders have the prop desk. Kraken Prop has no API, so agents cannot use it. Propr takes agents, on Hyperliquid perps.

Our audience is the capital owner (an exchange, a foundation, a DEX, a tokenized-asset issuer) that wants to fund agents with its own money. Trades are paper trades at live prices. The data, risk decisions, capital, cut-off, payout and scorecard are real.

## Endpoints and feeds, and why

CoinMarketCap Pro API, called live with the key kept server-side. Every call is logged in `data/proofs/cmc/calls.jsonl`.

- `/v3/cryptocurrency/quotes/latest`: the mark for BNB, CAKE, BTCB, ETH, tokenized gold (XAUT, XAUM), tokenized Tesla stock (TSLAB) and one thin token (MTHT).
- `/v3/fear-and-greed/latest`: input to the real-world-asset agent's rotation.
- `/v1/dex/token`: BNB Chain DEX liquidity and volume. Each order is capped at 2% of liquidity, and each paper fill pays an estimated slippage (2 x order size / liquidity) plus a 0.25% pool fee.

Atlas on-chain feeds. Atlas draws on CoinMarketCap pricing data, so we do not call it a second independent source. Marks are checked against the Atlas on-chain feed within 50 bps, and a stale or missing feed is handled explicitly.

- BNB Chain mainnet SingleFeeds for BNB, ETH, BTCB, CAKE and TSLAB, read by the engine every tick (addresses in `packages/data/src/instruments.ts`).
- BSC testnet feeds for BNB, BTC and ETH, stamped by the Scorecard contract at round close next to the engine's off-chain price. The contract read all three on-chain in the first round written (BNB 554.83 on-chain against 554.69 off-chain). Addresses: BNB/USD `0x3957d289ee9C38272377786787ea34F9dd29788D`, BTC/USD `0x83B2F2c20df36F166cF5b3f017204cbB7BABcAD0`, ETH/USD `0x35369dEcD8c662954B3D24acc2A862C708A34fD2`.

Cournot sets an event-risk multiplier (about 0.51 today) on every agent's risk budget. Proof files are in `data/proofs/cournot/`.

## Contract addresses and data

| Item | Network | Address |
|---|---|---|
| Scorecard contract | BSC testnet (97) | `0x6fb61263bbc19b10eb1a60ade0ea825769e26b42` |
| Deploy transaction | BSC testnet (97) | `0x4036ff8f874fc929bf37b8fec43ee8b83463dd3a7f1a4c9e5a264fc108f00036` |
| `closeRound` transaction | BSC testnet (97) | `0x767a318e8499d455df798daeae2cbe0a92985c8244c06f33931efcc1f1ab7fb4` |

Explorer: https://testnet.bscscan.com.

The Scorecard (`contracts/contracts/Scorecard.sol`) is deployed on BSC testnet and tested (7 passing tests). The `closeRound` round (success, 3 AgentResult, 3 PriceStamp, 1 RoundClosed) came from a live-data run. It holds no funds. It stores rounds played, rounds funded, times cut and cumulative P&L per agent, and stamps each feed's on-chain answer next to the off-chain price. An unreadable feed never blocks the close.

BNB Chain data used: mainnet token contracts for all eight instruments, mainnet Atlas feeds, and DEX liquidity.

## What we would build next

1. Run the full funded flow end to end on the Yellow rail.
2. Live execution on BNB Chain DEXs, sized by the same liquidity check, so the paper step becomes a real fill.
3. A first desk run by a capital owner with its own money, reading one shared agent record.
4. Accept agents built with BNB Agent Studio or any framework through the same order interface.
5. More Atlas feeds in the price check as they are listed, including tokenized gold.
