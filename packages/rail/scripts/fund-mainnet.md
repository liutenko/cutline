# Funding the desk on BNB Chain (mainnet, real funds)

The owner runs these steps by hand, once. No worker or agent runs them.

## What is on-chain and what is not

| Step | Where | Gas | Shows on BscScan |
|---|---|---|---|
| `approveToken` | BNB Chain, USDT contract | yes | yes, an ERC-20 approve to the ChannelHub |
| `deposit` | Yellow node, off-chain state | no | no |
| `checkpoint` after deposit | BNB Chain, ChannelHub | yes | **yes: this is the deposit transaction to show** |
| open session, deposit into session, reallocate, close | Yellow node, off-chain | no | no |
| `withdraw` | Yellow node, off-chain state | no | no |
| `checkpoint` after withdraw | BNB Chain, ChannelHub | yes | **yes: this is the payout transaction to show** |

Production values, confirmed read-only from `wss://nitronode.yellow.org/v1/ws` on 2026-11-26:

- Chain 56 `bsc`, ChannelHub `0x1a2f750170474d4c54f8d318d9d4343588b4c4d1`
- `usdt` on chain 56: `0x55d398326f99059ff775485246999027b3197955` (18 decimals on-chain; the node tracks 6)
- `usdc` on chain 56: `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d` (18 decimals on-chain; the node tracks 6)

## 0. Decide which key is the desk

`.env.example` says the hackathon keys are test keys that must never be funded on mainnet. Generate a fresh key for the mainnet desk and add it to the repo-root `.env` as `DESK_KEY_MAINNET`. The rail and the script below use `DESK_KEY_MAINNET` on mainnet when it is set, and `DESK_KEY` otherwise. The same `_MAINNET` override works for `RISK_KEY`, `AGENT_MOMENTUM_KEY`, `AGENT_RWA_KEY` and `AGENT_EVENT_KEY`. Only the desk needs funds; the others only sign, and agents receive their payout into their Yellow account at close.

## 1. Put funds in the desk wallet

Send to the desk address on BNB Chain:

- about 10 USDT (BEP-20, contract above)
- about 0.005 BNB for gas (two transactions now, one or two more to withdraw later)

Print the desk address and current balances (read-only, no transactions):

```bash
cd packages/rail
npx tsx scripts/mainnet-funding.ts status
```

## 2. Deposit into the desk's Yellow account

```bash
npx tsx scripts/mainnet-funding.ts deposit 10 --yes-real-funds
```

This runs, in order:

1. `setHomeBlockchain('usdt', 56)` so the desk's account is homed on BNB Chain.
2. `approveToken(56, 'usdt', 10)`: on-chain approve. Prints the tx hash and BscScan link.
3. `deposit(56, 'usdt', 10)`: off-chain state co-signed by the node.
4. `checkpoint('usdt')`: on-chain ChannelHub transaction that pulls the 10 USDT in. Prints the tx hash and BscScan link. **This is the deposit transaction to show judges.**
5. `waitForCheckpoint`: waits until the node credits the balance.

Run `status` again; the balances at Yellow should show `usdt` 10.

## 3. Run the desk on mainnet

In the repo-root `.env`:

```
RAIL=yellow-mainnet
YELLOW_MAINNET_CONFIRM=real-funds
```

`YELLOW_MAINNET_CONFIRM` is a guard: without it, `open()` on `yellow-mainnet` refuses to commit funds. Opening the session moves 10 USDT from the desk's Yellow account into the app session. Reallocations and close are off-chain and cost no gas. At close, each participant's final allocation is released back to its own Yellow account.

## 4. Withdraw to wallets after the round

For each participant that ended with a balance (the desk, and any funded agent), the owner of that key runs:

```bash
npx tsx scripts/mainnet-funding.ts withdraw <amount> --yes-real-funds            # desk
npx tsx scripts/mainnet-funding.ts withdraw <amount> --yes-real-funds --as momentum
```

This runs `withdraw(56, 'usdt', amount)` (off-chain) and then `checkpoint('usdt')`, an on-chain ChannelHub transaction that sends the tokens to that wallet. **That checkpoint hash is the payout transaction to show on BscScan.** Each withdrawing address needs a little BNB for gas, so an agent that has never been funded with BNB cannot withdraw until someone sends it gas.

## Trust note

App sessions are off-chain state co-signed by the participants (to quorum) and by the Yellow node. No participant can take another's allocation without the desk and the risk manager both signing. The node is trusted for liveness: funds become withdrawable on-chain only after the node co-signs the release.
