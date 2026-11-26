# Write-up: CoinMarketCap x Atlas challenge

Last updated: 2026-11-26

## Problem and audience

BNB Chain has agent tooling and trading contests, but a winning agent has nowhere to go for capital, and capital cannot tell a good agent from a lucky one. Human traders have the prop desk. Exchange-run prop programs exist for human traders, and they are built for manual trading.

Our audience is the capital owner (an exchange, a foundation, a DEX, a tokenized-asset issuer) that wants to fund agents with its own money. Trades are paper trades at live prices. The data and risk decisions are real. Capital, cut-off, payout and scorecard are on-chain on BNB Smart Chain testnet, with test tokens.

## Endpoints and feeds, and why

CoinMarketCap Pro API, called live with the key kept server-side. Every call is logged in `data/proofs/cmc/calls.jsonl`.

- `/v3/cryptocurrency/quotes/latest`: the mark for BNB, CAKE, BTCB, ETH, tokenized gold (XAUT, XAUM), tokenized Tesla stock (TSLAB) and one thin token (MTHT).
- `/v3/fear-and-greed/latest`: input to the real-world-asset agent's rotation.
- `/v1/dex/token`: BNB Chain DEX liquidity and volume. Each order is capped at 2% of liquidity, and each paper fill pays an estimated slippage (2 x order size / liquidity) plus a 0.25% pool fee.

Atlas on-chain feeds. Atlas draws on CoinMarketCap pricing data, so we do not call it a second independent source. Marks are checked against the Atlas on-chain feed within 50 bps, and a stale or missing feed is handled explicitly.

- BNB Chain mainnet SingleFeeds for BNB, ETH, BTCB, CAKE and TSLAB, read by the engine every tick (addresses in `packages/data/src/instruments.ts`).
- BSC testnet feeds for BNB, BTC and ETH, stamped by the Scorecard contract at round close next to the engine's off-chain price. The contract read all three on-chain in the first round written (BNB 554.83 on-chain against 554.69 off-chain). Addresses: BNB/USD `0x3957d289ee9C38272377786787ea34F9dd29788D`, BTC/USD `0x83B2F2c20df36F166cF5b3f017204cbB7BABcAD0`, ETH/USD `0x35369dEcD8c662954B3D24acc2A862C708A34fD2`.

Cournot: three full assessments of crypto price markets (newest values 0.4872, 0.2793 and 0.0267, saved in `data/proofs/cournot/`) plus the divergence ranking. The highest adverse probability sets an event-risk multiplier (0.51 today) on every agent's risk budget; favorable claims never reduce it. We observed that on these assessments Cournot's probability equals the venue price; the gaps appear in the ranking.

## Contract addresses and data

| Item | Network | Address |
|---|---|---|
| Scorecard contract | BSC testnet (97) | `0x6fb61263bbc19b10eb1a60ade0ea825769e26b42` |
| Deploy transaction | BSC testnet (97) | `0x4036ff8f874fc929bf37b8fec43ee8b83463dd3a7f1a4c9e5a264fc108f00036` |
| `closeRound` transaction | BSC testnet (97) | `0x767a318e8499d455df798daeae2cbe0a92985c8244c06f33931efcc1f1ab7fb4` |

Explorer: https://testnet.bscscan.com.

The desk's pot is held by the DeskVault contract (`0x3c7ff14381299ffeb2d0c3b187f931bddc9fcbe2`) in a test stablecoin (`0x61377805405038a67d7e44a66c1d8530593ade0f`, no value). No allocation changes without the desk's transaction and the risk manager's EIP-712 signature. One full round ran on testnet: open, fund, cut, close and scorecard, each a transaction (links in the README, "One full round on-chain").

The Scorecard (`contracts/contracts/Scorecard.sol`) is deployed on BSC testnet and tested. The `closeRound` round (success, 3 AgentResult, 3 PriceStamp, 1 RoundClosed) came from a live-data run. It holds no funds. It stores rounds played, rounds funded, times cut and cumulative P&L per agent, and stamps each feed's on-chain answer next to the off-chain price. An unreadable feed never blocks the close.

BNB Chain data used: mainnet token contracts for all eight instruments, mainnet Atlas feeds, and DEX liquidity.

## What we would build next

1. Move to mainnet with real funds, and move allocation updates off-chain over state channels with the vault as the on-chain anchor.
2. Live execution on BNB Chain DEXs, sized by the same liquidity check, so the paper step becomes a real fill.
3. A first desk run by a capital owner with its own money, reading one shared agent record.
4. Accept agents built with BNB Agent Studio or any framework through the same order interface.
5. More Atlas feeds in the price check as they are listed, including tokenized gold.
