// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeskVault} from "./DeskVault.sol";

/// @title DeskFund
/// @notice Open vault for the prop desk. Anyone deposits the test stablecoin (tUSD) between rounds
///         and receives "Cutline Desk Share" (CDS) shares. The fund is the `desk` of a DeskVault:
///         at each round the operator moves part of the depositors' capital into the DeskVault pot,
///         and at close the remainder comes back here.
///
///         Three buckets share this contract's token balance:
///         - depositors: `totalAssets()` = balance - reserve - protocolFees;
///         - `reserve`: loss reserve, filled by 75% of every evaluation fee, takes the first loss of a round;
///         - `protocolFees`: 25% of every evaluation fee plus a 10% performance fee on round profit.
///
/// @dev Known limits (hackathon build, roadmap, not built):
///      - The operator and the DeskVault risk manager are trusted. Together they decide who is paid
///        what at close; depositors cannot veto a round.
///      - Capital is locked during a round. Deposits, mints, withdrawals and redemptions are all
///        blocked from openRound until closeRound. If the round never closes (for example the risk
///        manager's key is lost), the capital in the DeskVault stays locked.
///      - No withdrawal queue: a depositor who wants out during a round must wait for it to close.
///      - `totalAssets()` does not include the capital out in the DeskVault during a round. That is
///        safe only because every deposit and exit path is blocked while a round is active.
///      - `releaseReserveSurplus()` is permissionless and raises the share price in one step, so a
///        depositor who enters just before it is called receives part of that surplus.
///      - Test token only (tUSD on BNB Smart Chain testnet). Not for real funds.
///      - Not audited.
contract DeskFund is ERC4626, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Share of each evaluation fee that goes to the loss reserve (75%). The rest goes to protocolFees.
    uint256 public constant RESERVE_BPS = 7500;
    /// @notice Performance fee on round profit (10%), paid into protocolFees.
    uint256 public constant PERFORMANCE_FEE_BPS = 1000;
    /// @notice Reserve target as a share of depositor assets (10%). Anything above it can be released.
    uint256 public constant RESERVE_TARGET_BPS = 1000;
    uint256 private constant BPS = 10_000;

    /// @notice The DeskVault this fund is the desk of. Set once with setVault.
    DeskVault public deskVault;
    /// @notice The desk engine key that drives rounds.
    address public operator;
    /// @notice Loss-reserve bucket, held in this contract's token balance.
    uint256 public reserve;
    /// @notice Protocol bucket, held in this contract's token balance.
    uint256 public protocolFees;
    /// @notice True from openRound until closeRound.
    bool public roundActive;
    /// @notice Amount sent to the DeskVault for the active round.
    uint256 public roundPot;
    /// @notice Id of the active (or most recent) round.
    uint256 public activeRoundId;

    event VaultSet(address indexed vault);
    event OperatorSet(address indexed operator);
    event EvaluationFeePaid(bytes32 indexed agentId, address indexed payer, uint256 amount, uint256 toReserve, uint256 toProtocol);
    event RoundFunded(uint256 indexed roundId, uint256 amount);
    event RoundSettled(
        uint256 indexed roundId,
        uint256 pot,
        uint256 returned,
        uint256 profit,
        uint256 performanceFee,
        uint256 loss,
        uint256 coveredByReserve
    );
    event ReserveSurplusReleased(uint256 amount);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);

    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error VaultAlreadySet();
    error VaultNotSet();
    error VaultMismatch();
    error RoundActive();
    error NoActiveRound();
    error WrongRound(uint256 expected, uint256 got);
    error AmountExceedsAssets(uint256 amount, uint256 available);
    error FundMustBeFirst();
    error AmountExceedsFees(uint256 amount, uint256 available);
    error NoDepositors();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier whenIdle() {
        if (roundActive) revert RoundActive();
        _;
    }

    /// @param asset_ The test stablecoin (TestUSD, 6 decimals).
    /// @param owner_ Owner: sets the vault once, changes the operator, withdraws protocol fees.
    /// @param operator_ The desk engine key that opens, reallocates and closes rounds.
    constructor(IERC20 asset_, address owner_, address operator_)
        ERC20("Cutline Desk Share", "CDS")
        ERC4626(asset_)
        Ownable(owner_)
    {
        if (address(asset_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    // ---------- admin ----------

    /// @notice Links the DeskVault whose `desk` is this fund. Owner only, once.
    /// @dev Checks that the vault holds the same token and names this contract as its desk.
    function setVault(DeskVault vault) external onlyOwner {
        if (address(vault) == address(0)) revert ZeroAddress();
        if (address(deskVault) != address(0)) revert VaultAlreadySet();
        if (vault.desk() != address(this) || address(vault.token()) != asset()) revert VaultMismatch();
        deskVault = vault;
        emit VaultSet(address(vault));
    }

    /// @notice Changes the operator. Owner only.
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice Sends protocol fees out. Owner only, between rounds.
    function withdrawProtocolFees(address to, uint256 amount) external onlyOwner whenIdle nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > protocolFees) revert AmountExceedsFees(amount, protocolFees);
        protocolFees -= amount;
        emit ProtocolFeesWithdrawn(to, amount);
        IERC20(asset()).safeTransfer(to, amount);
    }

    // ---------- fees and reserve ----------

    /// @notice Pays an agent's evaluation fee. Anyone, at any time. 75% fills the loss reserve, 25% goes to the protocol.
    /// @dev Does not change totalAssets(): the fee is split entirely between reserve and protocolFees.
    function payEvaluationFee(bytes32 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 toReserve = (amount * RESERVE_BPS) / BPS;
        uint256 toProtocol = amount - toReserve;
        reserve += toReserve;
        protocolFees += toProtocol;
        emit EvaluationFeePaid(agentId, msg.sender, amount, toReserve, toProtocol);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Moves the part of the reserve above its target (10% of depositor assets) to the depositors.
    ///         Anyone, between rounds. Reverts when there are no shares, since released assets would
    ///         otherwise accrue to no one.
    /// @return released Amount moved from the reserve to the depositors.
    function releaseReserveSurplus() external whenIdle nonReentrant returns (uint256 released) {
        if (totalSupply() == 0) revert NoDepositors();
        uint256 target = reserveTarget();
        if (reserve > target) {
            released = reserve - target;
            reserve = target;
        }
        emit ReserveSurplusReleased(released);
    }

    // ---------- rounds ----------

    /// @notice Funds a DeskVault round with `amount` of depositor capital.
    /// @param roundId New round id (DeskVault rejects reused ids).
    /// @param ids Participant ids; index 0 is the desk (this fund).
    /// @param payouts Payout addresses; index 0 must be this fund.
    /// @param amount Pot size. At most totalAssets().
    function openRound(uint256 roundId, bytes32[] calldata ids, address[] calldata payouts, uint256 amount)
        external
        onlyOperator
        nonReentrant
        whenIdle
    {
        DeskVault vault = deskVault;
        if (address(vault) == address(0)) revert VaultNotSet();
        if (amount == 0) revert ZeroAmount();
        uint256 available = totalAssets();
        if (amount > available) revert AmountExceedsAssets(amount, available);
        if (payouts.length == 0 || payouts[0] != address(this)) revert FundMustBeFirst();

        roundActive = true;
        roundPot = amount;
        activeRoundId = roundId;
        emit RoundFunded(roundId, amount);

        IERC20(asset()).forceApprove(address(vault), amount);
        vault.openRound(roundId, ids, payouts, amount);
    }

    /// @notice Forwards a reallocation to the DeskVault. Needs the risk manager's signature.
    function reallocate(
        uint256 roundId,
        uint256 newVersion,
        uint256[] calldata allocations,
        string calldata memo,
        bytes calldata riskSig
    ) external onlyOperator {
        DeskVault vault = deskVault;
        if (address(vault) == address(0)) revert VaultNotSet();
        vault.reallocate(roundId, newVersion, allocations, memo, riskSig);
    }

    /// @notice Closes the active round through the DeskVault and settles the result against the pot.
    /// @dev Same as closeRoundWithProceeds with zero proceeds.
    function closeRound(uint256 roundId, uint256 newVersion, uint256[] calldata finalAllocations, bytes calldata riskSig)
        external
        onlyOperator
        nonReentrant
    {
        _closeRound(roundId, newVersion, finalAllocations, riskSig, 0);
    }

    /// @notice Closes the active round and also brings in `proceeds`: the round's realized trading
    ///         gains settled off the DeskVault (the DeskVault itself can only pay out its pot).
    ///         The operator must have approved `proceeds` to this fund.
    /// @dev Profit or loss is measured as the balance change across the call, so it counts both the
    ///      DeskVault's payout to the fund and the proceeds.
    function closeRoundWithProceeds(
        uint256 roundId,
        uint256 newVersion,
        uint256[] calldata finalAllocations,
        bytes calldata riskSig,
        uint256 proceeds
    ) external onlyOperator nonReentrant {
        _closeRound(roundId, newVersion, finalAllocations, riskSig, proceeds);
    }

    // ---------- ERC4626 ----------

    /// @notice Depositor assets: token balance minus the reserve and protocol buckets.
    /// @dev During a round the pot sits in the DeskVault and is NOT counted here. That is safe because
    ///      maxDeposit/maxMint/maxWithdraw/maxRedeem return 0 while a round is active, so nobody can
    ///      enter or exit at the lower price. A direct token transfer to this contract (a donation)
    ///      raises the depositor bucket only; the 10**3 virtual-share offset makes an inflation attack
    ///      on the first depositor cost the attacker far more than it can take.
    function totalAssets() public view override returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        uint256 locked = reserve + protocolFees;
        return bal > locked ? bal - locked : 0;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return roundActive ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return roundActive ? 0 : super.maxMint(receiver);
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return roundActive ? 0 : super.maxWithdraw(owner_);
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return roundActive ? 0 : super.maxRedeem(owner_);
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner_);
    }

    // ---------- views ----------

    /// @notice Reserve target: RESERVE_TARGET_BPS of depositor assets.
    function reserveTarget() public view returns (uint256) {
        return (totalAssets() * RESERVE_TARGET_BPS) / BPS;
    }

    /// @notice Share of depositor capital that is out in the active round, in basis points. 0 between rounds.
    function capitalAtRiskBps() external view returns (uint256) {
        if (!roundActive) return 0;
        return (roundPot * BPS) / (totalAssets() + roundPot);
    }

    /// @notice One-call snapshot for the UI.
    function fundState()
        external
        view
        returns (
            uint256 totalAssets_,
            uint256 totalSupply_,
            uint256 reserve_,
            uint256 protocolFees_,
            bool roundActive_,
            uint256 roundPot_,
            uint256 activeRoundId_
        )
    {
        return (totalAssets(), totalSupply(), reserve, protocolFees, roundActive, roundPot, activeRoundId);
    }

    // ---------- internals ----------

    /// @dev 10**3 virtual shares and assets (OZ ERC4626) against first-depositor inflation attacks.
    ///      Shares have 6 + 3 = 9 decimals: 1 tUSD buys 1e9 share units on the first deposit.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    function _closeRound(
        uint256 roundId,
        uint256 newVersion,
        uint256[] calldata finalAllocations,
        bytes calldata riskSig,
        uint256 proceeds
    ) private {
        if (!roundActive) revert NoActiveRound();
        if (roundId != activeRoundId) revert WrongRound(activeRoundId, roundId);
        IERC20 token = IERC20(asset());

        // The balance diff needs the external calls in the middle; nonReentrant guards every entry point.
        uint256 before = token.balanceOf(address(this));
        deskVault.closeRound(roundId, newVersion, finalAllocations, riskSig);
        if (proceeds > 0) token.safeTransferFrom(msg.sender, address(this), proceeds);
        uint256 returned = token.balanceOf(address(this)) - before;

        uint256 pot = roundPot;
        uint256 profit;
        uint256 perf;
        uint256 loss;
        uint256 covered;
        if (returned >= pot) {
            profit = returned - pot;
            perf = (profit * PERFORMANCE_FEE_BPS) / BPS;
            protocolFees += perf;
        } else {
            loss = pot - returned;
            covered = loss < reserve ? loss : reserve;
            // Moving reserve tokens into the depositor bucket: depositors only lose loss - covered.
            reserve -= covered;
        }
        roundActive = false;
        roundPot = 0;
        emit RoundSettled(roundId, pot, returned, profit, perf, loss, covered);
    }
}
