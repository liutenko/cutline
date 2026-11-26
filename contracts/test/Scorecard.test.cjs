const { expect } = require('chai');
const hre = require('hardhat');
const { keccak256, toBytes, zeroAddress } = require('viem');

const id = (s) => keccak256(toBytes(s));
const H = keccak256(toBytes('state'));

async function setup() {
  const [desk, other] = await hre.viem.getWalletClients();
  const sc = await hre.viem.deployContract('Scorecard', [desk.account.address]);
  const f1 = await hre.viem.deployContract('MockFeed', [60000000000n]);
  const f2 = await hre.viem.deployContract('MockFeed', [250000000n]);
  const f3 = await hre.viem.deployContract('MockFeed', [100000000n]);
  for (const [k, n] of [['momentum', 'Momentum'], ['rwa', 'RWA Rotator'], ['event', 'Event Trader']])
    await sc.write.registerAgent([id(k), n, other.account.address, `${k} strategy`]);
  return { sc, desk, other, f1, f2, f3 };
}

describe('Scorecard', () => {
  it('registers and updates agents', async () => {
    const { sc, other } = await setup();
    expect(await sc.read.agentCount()).to.equal(3n);
    expect(await sc.read.agentIdAt([0n])).to.equal(id('momentum'));
    await sc.write.registerAgent([id('momentum'), 'Momentum v2', other.account.address, 'new']);
    const a = await sc.read.getAgent([id('momentum')]);
    expect(a[0]).to.equal('Momentum v2');
    expect(a[3]).to.equal(true);
    expect(await sc.read.agentCount()).to.equal(3n);
    expect((await sc.read.getAgent([id('nope')]))[3]).to.equal(false);
  });

  it('closes a round and updates records', async () => {
    const { sc, f1 } = await setup();
    await sc.write.closeRound([1n, [id('momentum'), id('rwa'), id('event')], [120n, -40n, -700n], [1, 1, 2], H, [f1.address], [60010000000n]]);
    expect(await sc.read.roundClosed([1n])).to.equal(true);
    const r = await sc.read.getRecord([id('event')]);
    expect(r.roundsPlayed).to.equal(1);
    expect(r.timesCut).to.equal(1);
    expect(r.cumulativePnlBps).to.equal(-700n);
    const m = await sc.read.getRecord([id('momentum')]);
    expect(m.roundsFunded).to.equal(1);
    expect(m.bestPnlBps).to.equal(120n);
    const logs = await sc.getEvents.PriceStamp();
    expect(logs[0].args.readOk).to.equal(true);
    expect(logs[0].args.onchainAnswer).to.equal(60000000000n);
  });

  it('reverts on double close and length mismatch', async () => {
    const { sc } = await setup();
    await sc.write.closeRound([1n, [id('momentum')], [1n], [1], H, [], []]);
    await expect(sc.write.closeRound([1n, [id('momentum')], [1n], [1], H, [], []])).to.be.rejectedWith('RoundAlreadyClosed');
    await expect(sc.write.closeRound([2n, [id('momentum')], [1n, 2n], [1], H, [], []])).to.be.rejectedWith('LengthMismatch');
  });

  it('reverts for non-operator', async () => {
    const { sc, other } = await setup();
    await expect(sc.write.closeRound([1n, [], [], [], H, [], []], { account: other.account })).to.be.rejectedWith('NotOperator');
    await expect(sc.write.registerAgent([id('x'), 'x', zeroAddress, 'x'], { account: other.account })).to.be.rejectedWith('NotOperator');
  });

  it('a reverting feed does not break closeRound', async () => {
    const { sc, f1, f2 } = await setup();
    await f1.write.setRevert([true]);
    await sc.write.closeRound([1n, [id('rwa')], [5n], [1], H, [f1.address, f2.address, zeroAddress], [1n, 2n, 3n]]);
    expect(await sc.read.roundClosed([1n])).to.equal(true);
    const logs = await sc.getEvents.PriceStamp();
    expect(logs.map((l) => l.args.readOk)).to.deep.equal([false, true, false]);
  });

  it('accumulates over two rounds', async () => {
    const { sc } = await setup();
    await sc.write.closeRound([1n, [id('momentum')], [300n], [1], H, [], []]);
    await sc.write.closeRound([2n, [id('momentum')], [-100n], [2], H, [], []]);
    const r = await sc.read.getRecord([id('momentum')]);
    expect(r.roundsPlayed).to.equal(2);
    expect(r.roundsFunded).to.equal(1);
    expect(r.timesCut).to.equal(1);
    expect(r.cumulativePnlBps).to.equal(200n);
    expect(r.bestPnlBps).to.equal(300n);
    expect(r.lastRoundId).to.equal(2n);
  });

  it('gas for 3 agents and 3 feeds', async () => {
    const { sc, f1, f2, f3 } = await setup();
    const hash = await sc.write.closeRound([1n, [id('momentum'), id('rwa'), id('event')], [120n, -40n, 10n], [1, 1, 1], H, [f1.address, f2.address, f3.address], [1n, 2n, 3n]]);
    const rc = await (await hre.viem.getPublicClient()).getTransactionReceipt({ hash });
    console.log('      closeRound gas (first round, 3 agents, 3 feeds):', rc.gasUsed.toString());
  });
});
