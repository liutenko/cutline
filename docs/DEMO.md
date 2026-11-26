# Demo script: 3 minutes

Last updated: 2026-11-26

## Before you go on stage

1. Start the engine: `cd packages/engine && DATA=live RAIL=local TICK_MS=3000 npm start` (add `RAIL=yellow-sandbox` only if that rail has been tested the same day). With 3 second ticks an agent is funded about 18 seconds after Start.
2. Start the dashboard: `cd web && npm run dev`, open `http://localhost:5173`.
3. Check the header tag. "LIVE" means real data. The rail tag reads "Local rail", "Yellow sandbox rail" or "Yellow mainnet rail".
4. Say "Settlement runs on Yellow Network Protocol" only if the rail tag shows a Yellow rail. With the local rail, say "settlement rail" and that the funded Yellow flow is pending.
5. Open "Demo controls" (top right of the page) once so you know where the buttons are. Press Reset so the round is clean.
6. Have a second terminal ready with the fallback command below.

Controls in "Demo controls": Start, Pause, Reset, Close round; an agent selector with "Make <agent> go rogue"; a symbol selector (it marks which agent holds each symbol) and a size selector (-10%, -15%, -25%) with "Stress test: shock <symbol> by <size>".

## Script

| Time | On screen and what the presenter does | Presenter says |
|---|---|---|
| 0:00 | Title slide | "BNB Chain has made it easy to build a trading agent, and contests pay the winners. Then nothing. A winning agent has no route to capital, and nobody with capital can tell a good agent from a lucky one. Human traders solved this with the prop desk. Kraken launched one in May. It has no API, so agents are locked out. One firm takes agents, on another chain." |
| 0:30 | Dashboard. Point at the "LIVE" tag and the pot. Press "Demo controls", then **Start** | "This is a prop desk for AI agents. Three agents, a pot of 10 USDT. One point up front: the trades are paper trades at live prices. The data, the risk decisions, the capital, the cut, the payout and the record are real." |
| 0:50 | Order tape fills with orders. Hover a badge to show its six checks. Point at the "Desk economics" strip | "Every order goes through a risk manager before it counts. CoinMarketCap gives the price and the DEX liquidity, so no agent takes a position it could not exit. Paper fills pay estimated slippage and a pool fee. The mark is checked against the Atlas feed on-chain." |
| 1:10 | "Event risk, from Cournot" panel. Point at the claim, 48.6%, the venue price, the sources and the "Risk budgets at 51%" figure | "This panel is Cournot. A named claim, Bitcoin below 55,000 dollars before the new year, a probability of 48.6%, and the sources behind it. That probability sets every agent's risk budget to about half, before the event and not after the loss." |
| 1:30 | Leaderboard: agents reach "Funded" after the evaluation ticks (about 18 seconds after Start). Open the agent selector, choose an agent, press **Make <agent> go rogue** | "Agents that survive the evaluation get real capital out of the pot. Now one goes rogue." |
| 1:40 | Order tape: rogue orders in MTHT show red badges, each larger than the last. Point at the liquidity check | "An oversized order in a thin token. Blocked: too large for the liquidity. It tries again, larger. Blocked." |
| 1:55 | Symbol selector: pick a symbol marked "held by <the rogue agent>", size **-25%**, press **Stress test: shock <symbol> by -25%** | "Now the stress test. This price move is simulated and labelled synthetic. The agent breaks its loss limit." |
| 2:05 | Leaderboard shows the agent as cut; its allocation goes back to the desk in the Settlement bar. Press **Close round** | "It is cut, its positions are closed and its capital goes back to the pot. No human was involved. The round closes: one settlement pays the agents that made money. Settlement runs on Yellow Network Protocol." (see step 4 above) |
| 2:20 | Settlement panel and Economics strip. Show the Scorecard link from the on-chain links list, or open the `closeRound` transaction on testnet.bscscan.com (see README, "Deployed contracts") | "Each agent's record is written to a contract on BNB Chain, next to the Atlas price it was marked against. Anyone can read it." Say that the contract is on BSC testnet and read the Atlas testnet feeds on-chain when the round closed. Pre-opened tab: https://testnet.bscscan.com/tx/0x767a318e8499d455df798daeae2cbe0a92985c8244c06f33931efcc1f1ab7fb4 |
| 2:35 | Business slide | "Agents pay a fee to be evaluated, priced so a coin flip loses money. The desk keeps a share of profit. The desk is software: any capital owner can run one with its own money." |
| 2:50 | Close | "A prize pool is spent once. A desk can lose at most 6 percent per agent, gets its capital back, and leaves a track record that includes risk. Kraken Prop has no API. This is the desk for agents, on BNB Chain." |

Notes for the presenter:
- Do not say "first". If you name the other firm, it is Propr.
- The event-risk percentage does not move during the demo, because the Cournot answer is read from a saved proof. Point at the 51% figure and the claim instead of promising a change.
- If asked about the pass bar: "The demo bar is low so you can watch it in three minutes. The production bar is a profit target, a minimum number of trades and a minimum number of days."

## Fallback: live engine fails (30 seconds)

Replay mode plays a recording of live data. The dashboard says "Replay of live data recorded <time>", so say so out loud.

1. Press Ctrl-C in the engine terminal.
2. In the prepared terminal run: `cd packages/engine && DATA=replay REPLAY_FILE=data/recordings/2026-11-26.jsonl TICK_MS=1500 RAIL=local npm start`
3. Reload the dashboard, open "Demo controls", press **Start**, and continue the script from the 0:50 row. Use the same rogue and stress-test buttons.

Say: "The live feed is down, so this is a replay of data recorded this morning. The risk checks and the rest of the flow run the same way." The recording file must exist on the demo machine: `data/recordings/*.jsonl` is not committed (see `.gitignore`), so copy it there before the demo.
