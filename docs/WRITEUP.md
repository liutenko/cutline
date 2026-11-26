# Write-up: CoinMarketCap x Atlas challenge

Last updated: 2026-11-26

Team: Cutline. Solo builder: Stan Liutenko. Contact: the Cutline project page on HackQuest, or an issue on this repository.

## Problem and audience

BNB Chain has agent tooling and trading contests, but a winning agent has nowhere to go for capital, and capital cannot tell a good agent from a lucky one. Human traders have the prop desk, built for manual trading.

Our audience is the capital owner (an exchange, a foundation, a DEX, a tokenized-asset issuer) that wants to fund agents with its own money. Trades are paper trades at live prices. The data and risk decisions are real. Capital, cut-off, payout and scorecard are on-chain on BNB Smart Chain testnet, with test tokens.

## Endpoints and feeds, and why

CoinMarketCap Pro API, called live with the key kept server-side. Every call is logged in `data/proofs/cmc/calls.jsonl`.

- `/v3/cryptocurrency/quotes/latest`: the mark for BNB, CAKE, BTCB, ETH, tokenized gold (XAUT, XAUM), tokenized Tesla stock (TSLAB) and one thin token (MTHT).
- `/v3/fear-and-greed/latest`: input to the real-world-asset agent's rotation.
- `/v1/dex/token`: BNB Chain DEX liquidity and volume. Each order is capped at 2% of liquidity, and each paper fill pays an estimated slippage (2 x order size / liquidity) plus a 0.25% pool fee.

Atlas on-chain feeds. Atlas draws on CoinMarketCap pricing data, so we do not call it a second independent source. Marks are checked against the Atlas on-chain feed within 50 bps, and a stale or missing feed is handled explicitly.

- BNB Chain mainnet SingleFeeds for BNB, ETH, BTCB, CAKE and TSLAB, read by the engine every tick (addresses in `packages/data/src/instruments.ts`).
- BSC testnet feeds for BNB, BTC, ETH and tokenized gold (XAU/USD, Atlas feed 1189), stamped by the Scorecard contract at round close next to the engine's off-chain price. In the round of 26 Nov, 14:50 UTC, the contract read all four on-chain (Atlas against CoinMarketCap): BNB 551.65 / 551.67, BTC 60,741.37 / 60,756.43, ETH 1,697.30 / 1,697.51, gold 3,572.60 / 3,572.29. Addresses: BNB/USD `0x3957d289ee9C38272377786787ea34F9dd29788D`, BTC/USD `0x83B2F2c20df36F166cF5b3f017204cbB7BABcAD0`, ETH/USD `0x35369dEcD8c662954B3D24acc2A862C708A34fD2`, XAU/USD `0xb3c87f255ce00b2692dc0eaf3e5985fbe2489764`.

Cournot, called live in the same round at 14:50:23 UTC. The claim that set the budget: "Bitcoin price below $55,000 at any time before 2027-01-01 05:00 UTC" (Cournot market 1341), probability 0.4782. Two more claims and the divergence ranking were saved with it. The highest adverse probability sets an event-risk multiplier on every agent's risk budget (0.52 in that round, so 52% of the budget was kept); favorable claims never reduce it. Each raw response is saved in `data/proofs/cournot/20261126T145023Z-*.json` with the evidence Cournot returned (source markets with URLs and timestamps), the HTTP status, the request time and the client commit; only the caller's IP is redacted. We observed that Cournot's probability equals the venue price on these claims; the gaps appear in the ranking.

## Contract addresses and data

All on BSC testnet (chain 97). Explorer: https://testnet.bscscan.com.

| Item | Address |
|---|---|
| Scorecard | `0x6fb61263bbc19b10eb1a60ade0ea825769e26b42` |
| DeskFund, depositor vault prototype (test wallets only) | `0x75d3554D6928720E33F42Dffc602759193a04501` |
| DeskVault funded by DeskFund | `0x32531012539B280f430AFa1eEC6f809040CE83bF` |
| DeskVault, earlier desk-funded rounds | `0x3c7ff14381299ffeb2d0c3b187f931bddc9fcbe2` |
| Test stablecoin (no value) | `0x61377805405038a67d7e44a66c1d8530593ade0f` |

The 14:50 UTC round ran on depositor capital, each step a transaction: [open](https://testnet.bscscan.com/tx/0xb6a5b0c4f2640501f1a93845e3b330d62b842eb39060ba911a9828a5bb7867bc) (DeskFund moved 10 tUSD into DeskVault), [fund](https://testnet.bscscan.com/tx/0xaf9ca7db38069a2e5c683d96c1f4baf12ea2c44764fcee55da08a32ea0c0248d) (3 tUSD to the gold agent), [cut](https://testnet.bscscan.com/tx/0xc7ae40284cfaf99d6ecb88066e8985b52c462bb5eabe546f87974dbe370c2614) (a labelled, simulated 25% gold drop pushed its daily loss to 9.23%, over the 3% limit; 2.711043 tUSD returned to the desk), [close](https://testnet.bscscan.com/tx/0x1e37be2114f9a7283709872c1625a6149cf3e6e8eeb146c44f7cf70016db2177) and [scorecard](https://testnet.bscscan.com/tx/0xa76a84e662c4d659034e9e651cf1f70b9b141638f40b161572ae1642c94ece40) (3 AgentResult, 4 PriceStamp, 1 RoundClosed).

No allocation changes without the desk's transaction and the risk manager's EIP-712 signature. The Scorecard (`contracts/contracts/Scorecard.sol`) holds no funds. It stores each agent's rounds, fundings, cuts and cumulative P&L, plus the price stamps. An unreadable feed never blocks the close.

BNB Chain data used: mainnet token contracts for all eight instruments, mainnet Atlas feeds, and DEX liquidity.

## What we would build next

1. Within 30 days: the vault and Scorecard on BNB Chain mainnet with a small operator pot, and outside agents joining, built with any framework.
2. Within 90 days: live execution on BNB Chain DEXs, sized by the same liquidity check, with evaluation fees and the loss reserve switched on.
3. Within 180 days: sponsor desks run by capital owners with their own money, tiered allocations, and allocation updates over state channels with the vault as the on-chain anchor.
4. More Atlas feeds in the price check as they are listed (tokenized gold is already stamped on testnet).
5. The open vault: the DeskFund prototype, where evaluation fees fill a reserve that pays before depositors, opened to the public once a legal structure is in place.
