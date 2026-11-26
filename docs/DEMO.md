# Demo script: 3 minutes

Last updated: 2026-11-26

## Before you go on stage

1. Start the engine: `cd packages/engine && DATA=live RAIL=local TICK_MS=3000 npm start` (use `RAIL=bnb-testnet-vault` to settle on testnet; each on-chain step takes about 5 seconds and the engine queues them). With 3 second ticks an agent is funded about 18 seconds after Start.
2. Start the dashboard: `cd web && npm run dev`, open `http://localhost:5173`.
3. Check the header tag. "LIVE" means real data. The rail tag shows which rail runs.
4. Be honest about the mode. With the vault rail the capital moves on BNB Smart Chain testnet with test tokens. With the local rail nothing is on-chain, so say so, and open the transactions from the README table instead. Open the cut, close and scorecard transactions in browser tabs beforehand.
5. Learn the layout. Three columns: on the left the "Desk economics" block (pot, capital at risk, paid to agents, losses absorbed) above the agent leaderboard; in the centre the order tape; on the right "Event risk, from Cournot", then "Settlement, on-chain". "Demo controls" is a button at the bottom right. Open it once, then press Reset so the round is clean.
6. Have a second terminal ready with the fallback command below.
7. Each on-chain step takes about 5 seconds. While the Settlement panel shows "1 transaction confirming", keep talking. Do not wait in silence.

Controls in "Demo controls" (bottom right): Start, Pause, Reset, Close round; an agent selector with "Make <agent> go rogue"; a symbol selector (it marks which agent holds each symbol) and a size selector (-10%, -15%, -25%) with "Stress test: shock <symbol> by <size>".

## Script

| Time | On screen and what the presenter does | Presenter says |
|---|---|---|
| 0:00 | Title slide | "BNB Chain has made it easy to build a trading agent, and contests pay the winners. Then nothing. A winning agent has no route to capital, and nobody with capital can tell a good agent from a lucky one. Human traders solved this with the prop desk. Exchange-run prop programs exist for human traders, and they are built for manual trading, so agents are locked out." |
| 0:30 | Dashboard. Point at the "LIVE" tag, the pot at top right and the "Desk economics" block at top left. Press "Demo controls" at the bottom right, then **Start** | "This is a prop desk for AI agents. Three agents, a pot of 10 test stablecoin units in a vault contract on BNB Smart Chain testnet. One point up front: the trades are paper trades at live prices. The data and the risk decisions are real. The capital, the cut, the payout and the record are on-chain on testnet, with test tokens." |
| 0:50 | Order tape (centre) fills with orders. Each approved or rejected order shows its six checks. Point at the estimated slippage and pool fee on a filled order | "Every order goes through a risk manager before it counts. CoinMarketCap gives the price and the DEX liquidity, so no agent takes a position it could not exit. Paper fills pay estimated slippage and a pool fee. The mark is checked against the Atlas feed on-chain." |
| 1:10 | "Event risk, from Cournot" panel (right). Point at the claim, 49%, the venue price, the sources and the "Risk budgets at 51%" figure | "This panel is Cournot. A named claim, Bitcoin below 55,000 dollars before the new year, a probability of about 49%, and the sources behind it. That probability sets every agent's risk budget to about half, before the event and not after the loss." |
| 1:30 | Leaderboard: agents reach "Funded" after the evaluation ticks (about 18 seconds after Start). In "Demo controls" choose an agent in the agent selector and press **Make <agent> go rogue** | "Agents that survive the evaluation get capital out of the vault. Now one goes rogue." |
| 1:40 | Order tape: rogue orders in MTHT show red badges, each larger than the last. Point at the liquidity check | "An oversized order in a thin token. Blocked: too large for the liquidity. It tries again, larger. Blocked." |
| 1:55 | In "Demo controls", symbol selector: pick a symbol marked "held by <the rogue agent>" (a -25% shock on a symbol the agent does not hold cuts nobody). Size selector **-25%**. Press **Stress test: shock <symbol> by -25%**. A symbol tagged SIMULATED SHOCK appears in the market strip | "Now the stress test. This price move is simulated and labelled synthetic. The agent breaks its loss limit." |
| 2:05 | Leaderboard (left) shows the agent as CUT; "Settlement, on-chain" (right) shows the allocation bar and a new transaction confirming (about 5 seconds, keep talking). Press **Close round** | "It is cut, its positions are closed and its capital goes back to the desk in its own transaction. No human was involved. Now the round closes with one settlement." Open the cut transaction (https://testnet.bscscan.com/tx/0x46c099efbcd47a0ef57d2e244309a074afd569d64c43d5433c5ff76417991813), then the close transaction (https://testnet.bscscan.com/tx/0xe6847d27c6f2c0c9787470803c70b452bfe48aa8bb53d6b73734bd46a2a7d45b) on BscScan testnet. These two are from a recorded full round; a live run shows its own links in the dashboard. |
| 2:20 | "Settlement, on-chain" panel: transaction links and the scorecard link. Show the Scorecard link there, or open the `closeRound` transaction on testnet.bscscan.com (see README, "Deployed contracts") | "Each agent's record is written to a contract on BNB Chain, next to the Atlas price it was marked against. Anyone can read it." The scorecard transaction for the full round is https://testnet.bscscan.com/tx/0x338777a64b590e8469b15890ea286d7a15dbf0d20f77c00ad10e129500c7aea8. Say that the contract is on BSC testnet and read the Atlas testnet feeds on-chain when the round closed. Pre-opened tab: https://testnet.bscscan.com/tx/0x767a318e8499d455df798daeae2cbe0a92985c8244c06f33931efcc1f1ab7fb4 |
| 2:35 | Business slide | "Agents pay a fee to be evaluated, priced so a coin flip loses money. The desk keeps a share of profit. The desk is software: any capital owner can run one with its own money." |
| 2:50 | Close | "A prize pool is spent once. A desk can lose at most 6 percent per agent, gets its capital back, and leaves a track record that includes risk. Prop programs are built for people. This is the desk for agents, on BNB Chain." |

Notes for the presenter:
- Do not say "first". Do not name other firms.
- The event-risk percentage does not move during the demo, because the Cournot answer is refreshed only every 15 minutes. Point at the 51% figure and the claim instead of promising a change.
- If asked about the pass bar: "The demo bar is low so you can watch it in three minutes. The production bar is a profit target, a minimum number of trades and a minimum number of days."

## Fallback: live engine fails (30 seconds)

Replay mode plays a recording of live data (the same testnet rail or the local rail, whichever you start it with). The dashboard says "Replay of live data recorded <time>", so say so out loud.

1. Press Ctrl-C in the engine terminal.
2. In the prepared terminal run: `cd packages/engine && DATA=replay REPLAY_FILE=data/recordings/2026-11-26.jsonl TICK_MS=1500 RAIL=local npm start`
3. Reload the dashboard, open "Demo controls", press **Start**, and continue the script from the 0:50 row. Use the same rogue and stress-test buttons.

Say: "The live feed is down, so this is a replay of data recorded this morning. The risk checks and the rest of the flow run the same way." The recording file must exist on the demo machine: `data/recordings/*.jsonl` is not committed (see `.gitignore`), so copy it there before the demo.
