const { expect } = require('chai');
const hre = require('hardhat');
const { keccak256, toBytes, encodeAbiParameters } = require('viem');

const id = (s) => keccak256(toBytes(s));
const U = (n) => BigInt(Math.round(n * 1e6)); // tUSD has 6 decimals
const IDS = ['desk', 'risk', 'momentum', 'rwa', 'event'].map(id);
const types = (primary) => ({
  [primary]: [
    { name: 'roundId', type: 'uint256' },
    { name: 'version', type: 'uint256' },
    { name: 'allocations', type: 'uint256[]' },
  ],
});

async function setup() {
  const [desk, risk, momentum, rwa, event, stranger] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const tusd = await hre.viem.deployContract('TestUSD', [desk.account.address]);
  const vault = await hre.viem.deployContract('DeskVault', [tusd.address, desk.account.address, risk.account.address]);
  await tusd.write.mint([desk.account.address, U(1000)]);
  await tusd.write.approve([vault.address, U(1000)]);
  const payouts = [desk, risk, momentum, rwa, event].map((w) => w.account.address);
  const chainId = await pub.getChainId();
  const sign = (signer, primary, roundId, version, allocations, opts = {}) =>
    signer.signTypedData({
      account: signer.account,
      domain: { name: 'DeskVault', version: '1', chainId: opts.chainId ?? chainId, verifyingContract: opts.vault ?? vault.address },
      types: types(primary),
      primaryType: primary,
      message: { roundId, version, allocations },
    });
  const open = () => vault.write.openRound([1n, IDS, payouts, U(10)]);
  return { desk, risk, momentum, rwa, event, stranger, pub, tusd, vault, payouts, sign, open };
}

describe('TestUSD', () => {
  it('has 6 decimals, the right name, and owner-only mint', async () => {
    const { tusd, stranger } = await setup();
    expect(await tusd.read.decimals()).to.equal(6);
    expect(await tusd.read.symbol()).to.equal('tUSD');
    expect(await tusd.read.name()).to.equal('Cutline Test USD');
    await expect(tusd.write.mint([stranger.account.address, 1n], { account: stranger.account })).to.be.rejectedWith('OwnableUnauthorizedAccount');
  });
});

describe('DeskVault', () => {
  it('happy path: open, three reallocations, close with payouts', async () => {
    const { vault, tusd, risk, sign, open, payouts, desk } = await setup();
    await open();
    expect(await vault.read.roundOpen()).to.equal(true);
    expect(await vault.read.version()).to.equal(1n);
    expect(await vault.read.pot()).to.equal(U(10));
    expect(await vault.read.allocations()).to.deep.equal([U(10), 0n, 0n, 0n, 0n]);
    expect(await tusd.read.balanceOf([vault.address])).to.equal(U(10));
    const [ids, pays] = await vault.read.participants();
    expect(ids).to.deep.equal(IDS);
    expect(pays.map((a) => a.toLowerCase())).to.deep.equal(payouts.map((a) => a.toLowerCase()));

    const steps = [
      [U(4), 0n, U(3), U(3), 0n],
      [U(4), 0n, U(3.4), U(2.6), 0n],
      [U(6.6), 0n, U(3.4), 0n, 0n],
    ];
    let v = 1n;
    for (const a of steps) {
      v += 1n;
      await vault.write.reallocate([1n, v, a, `step ${v}`, await sign(risk, 'Reallocate', 1n, v, a)]);
      expect(await vault.read.version()).to.equal(v);
      expect(await vault.read.allocations()).to.deep.equal(a);
    }
    const ev = await vault.getEvents.Reallocated();
    expect(ev[0].args.memo).to.equal('step 4');

    const final = [U(6.52), 0n, U(3.48), 0n, 0n];
    const deskBefore = await tusd.read.balanceOf([desk.account.address]);
    await vault.write.closeRound([1n, 5n, final, await sign(risk, 'CloseRound', 1n, 5n, final)]);
    expect(await vault.read.roundOpen()).to.equal(false);
    expect(await vault.read.version()).to.equal(5n);
    expect(await tusd.read.balanceOf([vault.address])).to.equal(0n);
    expect(await tusd.read.balanceOf([payouts[2]])).to.equal(U(3.48));
    expect((await tusd.read.balanceOf([desk.account.address])) - deskBefore).to.equal(U(6.52));
    const settled = await vault.getEvents.RoundSettled();
    expect(settled[0].args.stateHash).to.equal(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256[]' }], [1n, final])));
    // a new round with a new id can open afterwards; the old id cannot be reused
    await expect(vault.write.openRound([1n, IDS, payouts, U(1)])).to.be.rejectedWith('RoundIdUsed');
    await vault.write.openRound([2n, IDS, payouts, U(1)]);
    expect(await vault.read.currentRoundId()).to.equal(2n);
  });

  it('rejects a signature from anyone but the risk manager', async () => {
    const { vault, sign, open, desk, momentum } = await setup();
    await open();
    const a = [U(7), 0n, U(3), 0n, 0n];
    await expect(vault.write.reallocate([1n, 2n, a, 'x', await sign(desk, 'Reallocate', 1n, 2n, a)])).to.be.rejectedWith('BadRiskSignature');
    await expect(vault.write.reallocate([1n, 2n, a, 'x', await sign(momentum, 'Reallocate', 1n, 2n, a)])).to.be.rejectedWith('BadRiskSignature');
    await expect(vault.write.reallocate([1n, 2n, a, 'x', '0x1234'])).to.be.rejectedWith('BadRiskSignature');
  });

  it('rejects a signature over different allocations or the wrong type', async () => {
    const { vault, sign, open, risk } = await setup();
    await open();
    const a = [U(7), 0n, U(3), 0n, 0n];
    const b = [U(6), 0n, U(4), 0n, 0n];
    await expect(vault.write.reallocate([1n, 2n, b, 'x', await sign(risk, 'Reallocate', 1n, 2n, a)])).to.be.rejectedWith('BadRiskSignature');
    // a reallocate approval cannot be used to close, and vice versa
    await expect(vault.write.closeRound([1n, 2n, a, await sign(risk, 'Reallocate', 1n, 2n, a)])).to.be.rejectedWith('BadRiskSignature');
    await expect(vault.write.reallocate([1n, 2n, a, 'x', await sign(risk, 'CloseRound', 1n, 2n, a)])).to.be.rejectedWith('BadRiskSignature');
  });

  it('rejects a replayed or skipped version', async () => {
    const { vault, sign, open, risk } = await setup();
    await open();
    const a = [U(7), 0n, U(3), 0n, 0n];
    const sig = await sign(risk, 'Reallocate', 1n, 2n, a);
    await vault.write.reallocate([1n, 2n, a, 'x', sig]);
    await expect(vault.write.reallocate([1n, 2n, a, 'x', sig])).to.be.rejectedWith('BadVersion');
    await expect(vault.write.reallocate([1n, 4n, a, 'x', await sign(risk, 'Reallocate', 1n, 4n, a)])).to.be.rejectedWith('BadVersion');
    await expect(vault.write.reallocate([9n, 3n, a, 'x', await sign(risk, 'Reallocate', 9n, 3n, a)])).to.be.rejectedWith('WrongRound');
  });

  it('rejects allocations that do not sum to the pot or have the wrong length', async () => {
    const { vault, sign, open, risk } = await setup();
    await open();
    const over = [U(7), 0n, U(3.01), 0n, 0n];
    await expect(vault.write.reallocate([1n, 2n, over, 'x', await sign(risk, 'Reallocate', 1n, 2n, over)])).to.be.rejectedWith('SumMismatch');
    const short = [U(7), U(3)];
    await expect(vault.write.reallocate([1n, 2n, short, 'x', await sign(risk, 'Reallocate', 1n, 2n, short)])).to.be.rejectedWith('LengthMismatch');
    await expect(vault.write.closeRound([1n, 2n, over, await sign(risk, 'CloseRound', 1n, 2n, over)])).to.be.rejectedWith('SumMismatch');
  });

  it('rejects calls from anyone but the desk, even with a valid risk signature', async () => {
    const { vault, sign, open, risk, payouts } = await setup();
    await expect(vault.write.openRound([1n, IDS, payouts, U(10)], { account: risk.account })).to.be.rejectedWith('NotDesk');
    await open();
    const a = [U(7), 0n, U(3), 0n, 0n];
    const sig = await sign(risk, 'Reallocate', 1n, 2n, a);
    await expect(vault.write.reallocate([1n, 2n, a, 'x', sig], { account: risk.account })).to.be.rejectedWith('NotDesk');
    await expect(vault.write.closeRound([1n, 2n, a, await sign(risk, 'CloseRound', 1n, 2n, a)], { account: risk.account })).to.be.rejectedWith('NotDesk');
  });

  it('rejects a double open and bad open arguments', async () => {
    const { vault, open, payouts } = await setup();
    await expect(vault.write.openRound([1n, IDS, [payouts[1], ...payouts.slice(1)], U(10)])).to.be.rejectedWith('DeskMustBeFirst');
    await expect(vault.write.openRound([1n, IDS, payouts.slice(1), U(10)])).to.be.rejectedWith('LengthMismatch');
    await expect(vault.write.openRound([1n, IDS, payouts, 0n])).to.be.rejectedWith('ZeroAmount');
    await open();
    await expect(vault.write.openRound([2n, IDS, payouts, U(10)])).to.be.rejectedWith('RoundAlreadyOpen');
  });

  it('rejects a signature made for a different vault or a different chain', async () => {
    const { vault, sign, open, risk, tusd, desk } = await setup();
    const other = await hre.viem.deployContract('DeskVault', [tusd.address, desk.account.address, risk.account.address]);
    await open();
    const a = [U(7), 0n, U(3), 0n, 0n];
    await expect(vault.write.reallocate([1n, 2n, a, 'x', await sign(risk, 'Reallocate', 1n, 2n, a, { vault: other.address })])).to.be.rejectedWith('BadRiskSignature');
    await expect(vault.write.reallocate([1n, 2n, a, 'x', await sign(risk, 'Reallocate', 1n, 2n, a, { chainId: 97 })])).to.be.rejectedWith('BadRiskSignature');
    // sanity: the same allocation with the right domain is accepted
    await vault.write.reallocate([1n, 2n, a, 'x', await sign(risk, 'Reallocate', 1n, 2n, a)]);
  });

  it('rejects updates when no round is open', async () => {
    const { vault, sign, risk } = await setup();
    const a = [U(10)];
    await expect(vault.write.reallocate([1n, 2n, a, 'x', await sign(risk, 'Reallocate', 1n, 2n, a)])).to.be.rejectedWith('NoOpenRound');
  });
});
