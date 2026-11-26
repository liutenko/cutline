// Sandbox spike for the Yellow settlement rail. Testnet only: it refuses to run against mainnet.
//
//   npx tsx scripts/spike.ts            full flow if the desk is funded, plus the quorum probe
//   npx tsx scripts/spike.ts --faucet   also asks the sandbox faucet for test yusd first
//
// Part A (needs a funded desk): connect, getConfig, open (create + desk deposit), three reallocations,
//   close with a final split, then node balances for every participant.
// Part B (needs no funds): quorum probe on an empty session. Checks that the node rejects a create
//   signed by desk + all agents (no risk manager) and by risk + all agents (no desk), and accepts desk + risk.
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  AppSessionWalletSignerV1,
  AppStateUpdateIntent,
  EthereumMsgSigner,
  packAppStateUpdateV1,
  packCreateAppSessionRequestV1,
  type AppDefinitionV1,
} from '@yellow-org/sdk';
import { YellowRail, weightsFor, KEY_ENV } from '../src/yellow.js';
import type { Hex } from '../../../shared/src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env'), quiet: true });

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function faucet(address: string): Promise<void> {
  const url = 'https://nitronode-sandbox.yellow.org/v1/faucet-app/requestTokens';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userAddress: address }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    log(`faucet HTTP ${r.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  } catch (e) {
    log(`faucet request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function partA(rail: YellowRail): Promise<boolean> {
  const participants = rail.defaultParticipants();
  const c = await rail.connect();
  const cfg = await c.getConfig();
  log(`connected to ${rail.cfg.wsUrl}; node ${cfg.nodeAddress}; chains ${cfg.blockchains.map((b) => `${b.id}:${b.name}`).join(', ')}`);
  for (const p of participants) log(`  ${p.id.padEnd(8)} ${p.role.padEnd(5)} ${p.address}`);
  const { weights, quorum } = weightsFor(participants);
  log(`weights ${JSON.stringify(Object.fromEntries(weights))}, quorum ${quorum}`);
  log('balances before', JSON.stringify(await rail.balances()));

  const amount = process.env.SPIKE_AMOUNT || '10';
  let r;
  try {
    r = await rail.open({ participants, asset: 'usdt', amount });
  } catch (e) {
    log(`PART A STOPPED at open: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  log(`open        v${r.version} session ${r.sessionId}`, JSON.stringify(r.allocations), r.memo);
  const steps: [Record<string, string>, string][] = [
    [{ desk: '4', momentum: '3', rwa: '3' }, 'fund momentum and rwa, 3 each'],
    [{ desk: '4.25', momentum: '3.4', rwa: '2.35' }, 'track paper equity: momentum up, rwa down'],
    [{ desk: '6.6', momentum: '3.4', rwa: '0' }, 'cut rwa: allocation returned to desk'],
  ];
  for (const [next, memo] of steps) {
    r = await rail.reallocate(next, memo);
    log(`reallocate  v${r.version}`, JSON.stringify(r.allocations), memo);
  }
  r = await rail.close({ desk: '6.92', momentum: '3.08' });
  log(`close       v${r.version}`, JSON.stringify(r.allocations), r.memo, `status=${rail.state()?.status}`);
  const live = await c.getAppSessions({ appSessionId: r.sessionId });
  const s = live.sessions[0];
  log(`node view: isClosed=${s?.isClosed} version=${s?.version} allocations=${JSON.stringify(s?.allocations.map((a) => [a.participant, a.asset, a.amount.toFixed()]))}`);
  log('balances after', JSON.stringify(await rail.balances()));
  return true;
}

async function partB(rail: YellowRail): Promise<void> {
  const c = await rail.connect();
  const participants = rail.defaultParticipants();
  const { weights, quorum } = weightsFor(participants);
  const signer = (id: string) =>
    new AppSessionWalletSignerV1(new EthereumMsgSigner(keyFor(id)));
  const definition = (): AppDefinitionV1 => ({
    applicationId: rail.cfg.applicationId,
    participants: participants.map((p) => ({ walletAddress: p.address, signatureWeight: weights.get(p.id)! })),
    quorum,
    nonce: BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
  });
  const tryCreate = async (label: string, ids: string[]) => {
    const def = definition();
    const data = JSON.stringify({ app: 'proving-ground', kind: 'quorum-probe' });
    const hash = packCreateAppSessionRequestV1(def, data);
    const sigs = await Promise.all(ids.map((id) => signer(id).signMessage(hash)));
    const w = ids.reduce((n, id) => n + weights.get(id)!, 0);
    try {
      const created = await c.createAppSession(def, data, sigs);
      log(`quorum probe: ${label} (weight ${w}/${quorum}) -> ACCEPTED, session ${created.appSessionId} v${created.version}`);
      return created;
    } catch (e) {
      log(`quorum probe: ${label} (weight ${w}/${quorum}) -> REJECTED: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  await tryCreate('desk + 3 agents, no risk', ['desk', 'momentum', 'rwa', 'event']);
  await tryCreate('risk + 3 agents, no desk', ['risk', 'momentum', 'rwa', 'event']);
  await tryCreate('one agent alone', ['momentum']);
  const ok = await tryCreate('desk + risk', ['desk', 'risk']);
  if (ok) {
    // Close the empty probe session. First try a close signed without the risk manager (must fail).
    const close = {
      appSessionId: ok.appSessionId,
      intent: AppStateUpdateIntent.Close,
      version: BigInt(ok.version) + 1n,
      allocations: [],
      sessionData: JSON.stringify({ kind: 'close' }),
    };
    const h = packAppStateUpdateV1(close);
    for (const [label, ids] of [
      ['close signed by desk + 3 agents', ['desk', 'momentum', 'rwa', 'event']],
      ['close signed by desk + risk', ['desk', 'risk']],
    ] as const) {
      try {
        await c.submitAppState(close, await Promise.all(ids.map((id) => signer(id).signMessage(h))));
        log(`quorum probe: ${label} -> ACCEPTED`);
      } catch (e) {
        log(`quorum probe: ${label} -> REJECTED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const { sessions } = await c.getAppSessions({ appSessionId: ok.appSessionId });
    log(`probe session after close: isClosed=${sessions[0]?.isClosed} version=${sessions[0]?.version}`);
  }
}

function keyFor(id: string): Hex {
  const v = process.env[KEY_ENV[id]!]!;
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex;
}

async function main() {
  const rail = new YellowRail('yellow-sandbox', process.env);
  if (!rail.cfg.wsUrl.includes('sandbox')) throw new Error('spike runs on the sandbox only');
  if (process.argv.includes('--faucet')) await faucet(rail.addressOf('desk'));
  const funded = await partA(rail);
  log(funded ? 'PART A: full flow completed' : 'PART A: not completed (see reason above)');
  await partB(rail);
  await rail.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('spike failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
