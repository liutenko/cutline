const { expect } = require('chai');
const hre = require('hardhat');
const { keccak256, toBytes, getAddress } = require('viem');

const id = (s) => keccak256(toBytes(s));
const U = (n) => BigInt(Math.round(n * 1e6)); // tUSD has 6 decimals
const S = (n) => U(n) * 1000n; // CDS shares: 6 + 3 (offset) = 9 decimals
const IDS = ['desk', 'momentum', 'rwa'].map(id);
const types = (primary) => ({
  [primary]: [
    { name: 'roundId', type: 'uint256' },
    { name: 'version', type: 'uint256' },
    { name: 'allocations', type: 'uint256[]' },
  ],
});

async function setup() {
  const [owner, operator, risk, momentum, rwa, alice, bob, stranger] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const tusd = await hre.viem.deployContract('TestUSD', [owner.account.address]);
  const fund = await hre.viem.deployContract('DeskFund', [tusd.address, owner.account.address, operator.account.address]);
  const vault = await hre.viem.deployContract('DeskVault', [tusd.address, fund.address, risk.account.address]);
  await fund.write.setVault([vault.address]);
  for (const w of [operator, alice, bob, stranger]) await tusd.write.mint([w.account.address, U(1000)]);

  const chainId = await pub.getChainId();
  const payouts = [fund.address, momentum.account.address, rwa.account.address];
  const sign = (primary, roundId, version, allocations, signer = risk) =>
    signer.signTypedData({
      account: signer.account,
      domain: { name: 'DeskVault', version: '1', chainId, verifyingContract: vault.address },
      types: types(primary),
      primaryType: primary,
      message: { roundId, version, allocations },
    });
  const as = (w) => ({ account: w.account });
  const deposit = async (w, amount) => {
    await tusd.write.approve([fund.address, amount], as(w));
    await fund.write.deposit([amount, w.account.address], as(w));
  };
  const payFee = async (w, agent, amount) => {
    await tusd.write.approve([fund.address, amount], as(w));
    await fund.write.payEvaluationFee([id(agent), amount], as(w));
  };
  const open = (roundId, amount) => fund.write.openRound([roundId, IDS, payouts, amount], as(operator));
  const close = async (roundId, version, final, proceeds = 0n) => {
    const sig = await sign('CloseRound', roundId, version, final);
    if (proceeds === 0n) return fund.write.closeRound([roundId, version, final, sig], as(operator));
    await tusd.write.approve([fund.address, proceeds], as(operator));
    return fund.write.closeRoundWithProceeds([roundId, version, final, sig, proceeds], as(operator));
  };
  const bal = (a) => tusd.read.balanceOf([a.account ? a.account.address : a]);
  const redeemAll = async (w) => {
    const shares = await fund.read.balanceOf([w.account.address]);
    await fund.write.redeem([shares, w.account.address, w.account.address], as(w));
  };
  return { owner, operator, risk, momentum, rwa, alice, bob, stranger, pub, tusd, fund, vault, payouts, sign, as, deposit, payFee, open, close, bal, redeemAll };
}

describe('DeskFund', () => {
  it('is wired to its DeskVault and has the right share metadata', async () => {
    const { fund, vault, tusd, operator, owner } = await setup();
    expect(await fund.read.name()).to.equal('Cutline Desk Share');
    expect(await fund.read.symbol()).to.equal('CDS');
    expect(await fund.read.decimals()).to.equal(9);
    expect(getAddress(await fund.read.asset())).to.equal(getAddress(tusd.address));
    expect(getAddress(await fund.read.deskVault())).to.equal(getAddress(vault.address));
    expect(getAddress(await vault.read.desk())).to.equal(getAddress(fund.address));
    expect(getAddress(await fund.read.operator())).to.equal(getAddress(operator.account.address));
    expect(getAddress(await fund.read.owner())).to.equal(getAddress(owner.account.address));
  });

  it('1. deposit and redeem between rounds, 1:1 share math on the first deposit', async () => {
    const { fund, tusd, alice, bob, deposit, redeemAll, bal } = await setup();
    await deposit(alice, U(10));
    expect(await fund.read.balanceOf([alice.account.address])).to.equal(S(10));
    expect(await fund.read.totalAssets()).to.equal(U(10));
    expect(await fund.read.convertToAssets([S(1)])).to.equal(U(1));
    await deposit(bob, U(5));
    expect(await fund.read.balanceOf([bob.account.address])).to.equal(S(5));

    const before = await bal(alice);
    await redeemAll(alice);
    expect((await bal(alice)) - before).to.equal(U(10));
    await redeemAll(bob);
    expect(await fund.read.totalSupply()).to.equal(0n);
    expect(await tusd.read.balanceOf([fund.address])).to.equal(0n);
  });

  it('2. deposits, mints, withdrawals and redemptions revert during an active round', async () => {
    const { fund, tusd, alice, deposit, open, close, as } = await setup();
    await deposit(alice, U(10));
    await open(1n, U(6));
    expect(await fund.read.roundActive()).to.equal(true);
    expect(await fund.read.maxDeposit([alice.account.address])).to.equal(0n);
    expect(await fund.read.maxMint([alice.account.address])).to.equal(0n);
    expect(await fund.read.maxWithdraw([alice.account.address])).to.equal(0n);
    expect(await fund.read.maxRedeem([alice.account.address])).to.equal(0n);
    // pot is out in the DeskVault; totalAssets shows only what is left here
    expect(await fund.read.totalAssets()).to.equal(U(4));
    expect(await fund.read.capitalAtRiskBps()).to.equal(6000n);

    await tusd.write.approve([fund.address, U(5)], as(alice));
    const a = alice.account.address;
    await expect(fund.write.deposit([U(1), a], as(alice))).to.be.rejectedWith('ERC4626ExceededMaxDeposit');
    await expect(fund.write.mint([S(1), a], as(alice))).to.be.rejectedWith('ERC4626ExceededMaxMint');
    await expect(fund.write.withdraw([U(1), a, a], as(alice))).to.be.rejectedWith('ERC4626ExceededMaxWithdraw');
    await expect(fund.write.redeem([S(1), a, a], as(alice))).to.be.rejectedWith('ERC4626ExceededMaxRedeem');

    await close(1n, 2n, [U(6), 0n, 0n]);
    expect(await fund.read.roundActive()).to.equal(false);
    expect(await fund.read.totalAssets()).to.equal(U(10));
    await fund.write.deposit([U(1), a], as(alice));
    expect(await fund.read.totalAssets()).to.equal(U(11));
  });

  it('3. evaluation fee splits 75/25 into reserve and protocolFees and leaves totalAssets unchanged', async () => {
    const { fund, alice, stranger, deposit, payFee, open } = await setup();
    await deposit(alice, U(10));
    await payFee(stranger, 'momentum', U(0.1));
    expect(await fund.read.reserve()).to.equal(U(0.075));
    expect(await fund.read.protocolFees()).to.equal(U(0.025));
    expect(await fund.read.totalAssets()).to.equal(U(10));
    const ev = await fund.getEvents.EvaluationFeePaid();
    expect(ev[0].args.agentId).to.equal(id('momentum'));
    expect(getAddress(ev[0].args.payer)).to.equal(getAddress(stranger.account.address));
    expect(ev[0].args.amount).to.equal(U(0.1));
    expect(ev[0].args.toReserve).to.equal(U(0.075));
    expect(ev[0].args.toProtocol).to.equal(U(0.025));

    // fees can be paid during a round too
    await open(1n, U(5));
    await payFee(stranger, 'rwa', U(1));
    expect(await fund.read.reserve()).to.equal(U(0.825));
    expect(await fund.read.protocolFees()).to.equal(U(0.275));
    expect(await fund.read.totalAssets()).to.equal(U(5));
    await expect(fund.write.payEvaluationFee([id('x'), 0n], { account: stranger.account })).to.be.rejectedWith('ZeroAmount');
  });

  it('4. profitable round: agent paid its share, 10% performance fee, share price rises', async () => {
    const { fund, vault, momentum, alice, deposit, open, close, sign, operator, bal } = await setup();
    await deposit(alice, U(100));
    await open(1n, U(50));
    const step = [U(45), U(3), U(2)];
    await fund.write.reallocate([1n, 2n, step, 'momentum up', await sign('Reallocate', 1n, 2n, step)], { account: operator.account });
    expect(await vault.read.allocations()).to.deep.equal(step);

    // the round made 5 tUSD of realized gains; the momentum agent's profit share is 2 tUSD
    const momBefore = await bal(momentum);
    await close(1n, 3n, [U(48), U(2), 0n], U(5));
    expect((await bal(momentum)) - momBefore).to.equal(U(2));
    // returned 48 + 5 = 53 on a 50 pot: profit 3, performance fee 0.3
    expect(await fund.read.protocolFees()).to.equal(U(0.3));
    expect(await fund.read.totalAssets()).to.equal(U(102.7));
    expect((await fund.read.convertToAssets([S(1)])) > U(1)).to.equal(true);
    const [ev] = await fund.getEvents.RoundSettled();
    expect(ev.args.pot).to.equal(U(50));
    expect(ev.args.returned).to.equal(U(53));
    expect(ev.args.profit).to.equal(U(3));
    expect(ev.args.performanceFee).to.equal(U(0.3));
    expect(ev.args.loss).to.equal(0n);
    expect(await fund.read.roundPot()).to.equal(0n);
    expect(await fund.read.roundActive()).to.equal(false);

    const before = await bal(alice);
    await fund.write.redeem([S(100), alice.account.address, alice.account.address], { account: alice.account });
    const out = (await bal(alice)) - before;
    expect(out <= U(102.7) && out >= U(102.7) - 1n).to.equal(true);
  });

  it('5. losing round fully covered by the reserve: depositors unchanged, reserve reduced', async () => {
    const { fund, alice, stranger, deposit, payFee, open, close, rwa, bal } = await setup();
    await deposit(alice, U(100));
    await payFee(stranger, 'momentum', U(4)); // reserve 3, protocol 1
    await open(1n, U(50));
    // round lost money overall but the rwa agent still earned a 1 tUSD profit share
    const rwaBefore = await bal(rwa);
    await close(1n, 2n, [U(49), 0n, U(1)]);
    expect((await bal(rwa)) - rwaBefore).to.equal(U(1));
    expect(await fund.read.reserve()).to.equal(U(2));
    expect(await fund.read.protocolFees()).to.equal(U(1));
    expect(await fund.read.totalAssets()).to.equal(U(100));
    expect(await fund.read.convertToAssets([S(1)])).to.equal(U(1));
    const [ev] = await fund.getEvents.RoundSettled();
    expect(ev.args.loss).to.equal(U(1));
    expect(ev.args.coveredByReserve).to.equal(U(1));
    expect(ev.args.profit).to.equal(0n);
  });

  it('6. losing round partly covered: reserve emptied, depositors take the rest', async () => {
    const { fund, alice, stranger, deposit, payFee, open, close } = await setup();
    await deposit(alice, U(100));
    await payFee(stranger, 'event', U(1)); // reserve 0.75
    await open(1n, U(50));
    await close(1n, 2n, [U(48), U(2), 0n]); // loss 2
    expect(await fund.read.reserve()).to.equal(0n);
    expect(await fund.read.protocolFees()).to.equal(U(0.25));
    expect(await fund.read.totalAssets()).to.equal(U(98.75));
    const [ev] = await fund.getEvents.RoundSettled();
    expect(ev.args.loss).to.equal(U(2));
    expect(ev.args.coveredByReserve).to.equal(U(0.75));
  });

  it('7. only the operator drives rounds; only the owner sets the vault (once), operator and fees', async () => {
    const { fund, vault, tusd, owner, operator, risk, alice, stranger, deposit, payFee, open, close, sign, payouts, as, bal } = await setup();
    await deposit(alice, U(10));
    for (const w of [owner, stranger, risk]) {
      await expect(fund.write.openRound([1n, IDS, payouts, U(5)], as(w))).to.be.rejectedWith('NotOperator');
    }
    await open(1n, U(5));
    const a = [U(4), U(1), 0n];
    await expect(fund.write.reallocate([1n, 2n, a, 'x', await sign('Reallocate', 1n, 2n, a)], as(owner))).to.be.rejectedWith('NotOperator');
    await expect(fund.write.closeRound([1n, 2n, a, await sign('CloseRound', 1n, 2n, a)], as(stranger))).to.be.rejectedWith('NotOperator');
    await expect(fund.write.closeRoundWithProceeds([1n, 2n, a, await sign('CloseRound', 1n, 2n, a), 1n], as(stranger))).to.be.rejectedWith('NotOperator');
    // the DeskVault only accepts the fund as desk, even from the operator directly
    await expect(vault.write.reallocate([1n, 2n, a, 'x', await sign('Reallocate', 1n, 2n, a)], as(operator))).to.be.rejectedWith('NotDesk');
    // the risk signature is still enforced through the fund
    await expect(fund.write.reallocate([1n, 2n, a, 'x', await sign('Reallocate', 1n, 2n, a, operator)], as(operator))).to.be.rejectedWith('BadRiskSignature');

    // setVault: owner only, once, must point at this fund and token
    await expect(fund.write.setVault([vault.address], as(stranger))).to.be.rejectedWith('OwnableUnauthorizedAccount');
    await expect(fund.write.setVault([vault.address])).to.be.rejectedWith('VaultAlreadySet');
    const fresh = await hre.viem.deployContract('DeskFund', [tusd.address, owner.account.address, operator.account.address]);
    await expect(fresh.write.setVault(['0x0000000000000000000000000000000000000000'])).to.be.rejectedWith('ZeroAddress');
    await expect(fresh.write.setVault([vault.address])).to.be.rejectedWith('VaultMismatch');
    await expect(fresh.write.openRound([1n, IDS, [fresh.address, ...payouts.slice(1)], 1n], as(operator))).to.be.rejectedWith('VaultNotSet');

    // protocol fees: owner only, between rounds, at most the bucket
    await payFee(stranger, 'momentum', U(1));
    await expect(fund.write.withdrawProtocolFees([owner.account.address, U(0.1)])).to.be.rejectedWith('RoundActive');
    await close(1n, 2n, [U(5), 0n, 0n]);
    await expect(fund.write.withdrawProtocolFees([stranger.account.address, U(0.1)], as(stranger))).to.be.rejectedWith('OwnableUnauthorizedAccount');
    await expect(fund.write.withdrawProtocolFees([owner.account.address, U(0.26)])).to.be.rejectedWith('AmountExceedsFees');
    const before = await bal(owner);
    await fund.write.withdrawProtocolFees([owner.account.address, U(0.25)]);
    expect((await bal(owner)) - before).to.equal(U(0.25));
    expect(await fund.read.protocolFees()).to.equal(0n);
    expect(await fund.read.totalAssets()).to.equal(U(10));

    // setOperator: owner only; the old operator loses access
    await expect(fund.write.setOperator([stranger.account.address], as(stranger))).to.be.rejectedWith('OwnableUnauthorizedAccount');
    await fund.write.setOperator([stranger.account.address]);
    await expect(open(2n, U(1))).to.be.rejectedWith('NotOperator');
    await fund.write.openRound([2n, IDS, payouts, U(1)], as(stranger));
  });

  it('8. openRound rejects an amount above totalAssets, payouts[0] != fund, a double open; close checks the round', async () => {
    const { fund, alice, stranger, deposit, payFee, open, close, payouts, operator, momentum, sign } = await setup();
    await deposit(alice, U(10));
    await payFee(stranger, 'momentum', U(4)); // fees sit in the balance but are not depositor assets
    await expect(open(1n, U(10) + 1n)).to.be.rejectedWith('AmountExceedsAssets');
    await expect(open(1n, 0n)).to.be.rejectedWith('ZeroAmount');
    await expect(fund.write.openRound([1n, IDS, [momentum.account.address, ...payouts.slice(1)], U(1)], { account: operator.account })).to.be.rejectedWith('FundMustBeFirst');
    const a = [U(10), 0n, 0n];
    await expect(fund.write.closeRound([1n, 2n, a, await sign('CloseRound', 1n, 2n, a)], { account: operator.account })).to.be.rejectedWith('NoActiveRound');
    await open(1n, U(10));
    await expect(open(2n, U(1))).to.be.rejectedWith('RoundActive');
    await expect(fund.write.closeRound([7n, 2n, a, await sign('CloseRound', 7n, 2n, a)], { account: operator.account })).to.be.rejectedWith('WrongRound');
    await close(1n, 2n, a);
    expect(await fund.read.totalAssets()).to.equal(U(10));
  });

  it('9. releaseReserveSurplus moves the reserve above 10% of depositor assets to depositors', async () => {
    const { fund, alice, stranger, deposit, payFee, open, close, as } = await setup();
    await payFee(stranger, 'momentum', U(4)); // reserve 3
    await expect(fund.write.releaseReserveSurplus(as(stranger))).to.be.rejectedWith('NoDepositors');
    await deposit(alice, U(10));
    expect(await fund.read.reserveTarget()).to.equal(U(1));
    await open(1n, U(5));
    await expect(fund.write.releaseReserveSurplus(as(stranger))).to.be.rejectedWith('RoundActive');
    await close(1n, 2n, [U(5), 0n, 0n]);

    await fund.write.releaseReserveSurplus(as(stranger));
    expect(await fund.read.reserve()).to.equal(U(1));
    expect(await fund.read.totalAssets()).to.equal(U(12));
    expect(await fund.read.protocolFees()).to.equal(U(1));
    const ev = await fund.getEvents.ReserveSurplusReleased();
    expect(ev[0].args.amount).to.equal(U(2));
    // nothing above target now: a second call releases nothing
    await fund.write.releaseReserveSurplus(as(stranger));
    expect(await fund.read.reserve()).to.equal(U(1));
    expect(await fund.read.totalAssets()).to.equal(U(12));
  });

  it('10. two depositors share an uncovered loss pro rata', async () => {
    const { fund, alice, bob, deposit, open, close, redeemAll, bal } = await setup();
    await deposit(alice, U(60));
    await deposit(bob, U(40));
    await open(1n, U(100));
    await close(1n, 2n, [U(95), U(5), 0n]); // loss 5, no reserve
    expect(await fund.read.totalAssets()).to.equal(U(95));
    const a0 = await bal(alice);
    const b0 = await bal(bob);
    await redeemAll(alice);
    await redeemAll(bob);
    const aOut = (await bal(alice)) - a0;
    const bOut = (await bal(bob)) - b0;
    expect(Number(U(57) - aOut)).to.be.within(0, 1);
    expect(Number(U(38) - bOut)).to.be.within(0, 1);
  });

  it('a direct token donation cannot steal from the next depositor (decimals offset)', async () => {
    const { fund, tusd, alice, bob, deposit, redeemAll, bal, as } = await setup();
    // attacker (bob) deposits 1 unit, then donates 10 tUSD to inflate the share price
    await deposit(bob, 1n);
    await tusd.write.transfer([fund.address, U(10)], as(bob));
    // donation raises the depositor bucket only, not the reserve or fees
    expect(await fund.read.totalAssets()).to.equal(U(10) + 1n);
    expect(await fund.read.reserve()).to.equal(0n);
    await deposit(alice, U(10));
    expect((await fund.read.balanceOf([alice.account.address])) > 0n).to.equal(true);
    const a0 = await bal(alice);
    const b0 = await bal(bob);
    await redeemAll(alice);
    await redeemAll(bob);
    // victim keeps over 99.9%; attacker loses about half of the donation
    expect((await bal(alice)) - a0 > (U(10) * 999n) / 1000n).to.equal(true);
    expect((await bal(bob)) - b0 < U(6)).to.equal(true);
  });
});
