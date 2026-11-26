// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DeskVault
/// @notice Holds the prop desk's pot for one round at a time and tracks how it is allocated
///         between the desk and its funded agents. Every allocation change needs two parties:
///         the desk sends the transaction, and the risk manager signs the new state (EIP-712).
/// @dev Known limits (roadmap, not built):
///      - No timeout or escape hatch. If the risk manager's key is lost while a round is open,
///        the pot stays locked in this contract.
///      - The desk and the risk manager together are trusted: agents do not sign and cannot
///        block a reallocation or a cut.
///      - One round at a time; round ids cannot be reused, so old signatures cannot be replayed.
contract DeskVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice EIP-712 type for a reallocation approval.
    bytes32 public constant REALLOCATE_TYPEHASH =
        keccak256("Reallocate(uint256 roundId,uint256 version,uint256[] allocations)");
    /// @notice EIP-712 type for a round close approval. Distinct from REALLOCATE_TYPEHASH.
    bytes32 public constant CLOSE_TYPEHASH =
        keccak256("CloseRound(uint256 roundId,uint256 version,uint256[] allocations)");

    IERC20 public immutable token;
    address public immutable desk;
    address public immutable riskManager;

    /// @notice Id of the current (or most recent) round.
    uint256 public currentRoundId;
    /// @notice State version of the current round. 1 after open, +1 per reallocation and at close.
    uint256 public version;
    /// @notice Total pot of the current round. Allocations always sum to this.
    uint256 public pot;
    /// @notice True while a round is open.
    bool public roundOpen;
    /// @notice Round ids that have been used. A round id can be opened once.
    mapping(uint256 => bool) public roundUsed;

    bytes32[] private _participantIds;
    address[] private _payoutAddresses;
    uint256[] private _allocations;

    event RoundOpened(uint256 indexed roundId, bytes32[] participantIds, address[] payoutAddresses, uint256 amount);
    event Reallocated(uint256 indexed roundId, uint256 version, uint256[] allocations, string memo);
    event RoundSettled(uint256 indexed roundId, uint256 version, uint256[] finalAllocations, bytes32 stateHash);

    error NotDesk();
    error ZeroAddress();
    error RoundAlreadyOpen(uint256 roundId);
    error RoundIdUsed(uint256 roundId);
    error NoOpenRound();
    error WrongRound(uint256 expected, uint256 got);
    error BadVersion(uint256 expected, uint256 got);
    error LengthMismatch();
    error EmptyRound();
    error DeskMustBeFirst();
    error ZeroAmount();
    error SumMismatch(uint256 pot, uint256 sum);
    error BadRiskSignature(address recovered);

    modifier onlyDesk() {
        if (msg.sender != desk) revert NotDesk();
        _;
    }

    constructor(IERC20 token_, address desk_, address riskManager_) EIP712("DeskVault", "1") {
        if (address(token_) == address(0) || desk_ == address(0) || riskManager_ == address(0)) revert ZeroAddress();
        token = token_;
        desk = desk_;
        riskManager = riskManager_;
    }

    /// @notice Opens a round and pulls `amount` from the desk. The desk (index 0) starts with the whole pot.
    /// @param roundId New, never used round id.
    /// @param participantIds Participant ids; index 0 is the desk.
    /// @param payoutAddresses Where each participant is paid at close; index 0 must be the desk.
    /// @param amount Pot size in token units. The desk must have approved this vault.
    function openRound(
        uint256 roundId,
        bytes32[] calldata participantIds,
        address[] calldata payoutAddresses,
        uint256 amount
    ) external onlyDesk nonReentrant {
        if (roundOpen) revert RoundAlreadyOpen(currentRoundId);
        if (roundUsed[roundId]) revert RoundIdUsed(roundId);
        uint256 n = participantIds.length;
        if (n == 0) revert EmptyRound();
        if (payoutAddresses.length != n) revert LengthMismatch();
        if (payoutAddresses[0] != desk) revert DeskMustBeFirst();
        if (amount == 0) revert ZeroAmount();
        for (uint256 i = 1; i < n; i++) {
            if (payoutAddresses[i] == address(0)) revert ZeroAddress();
        }

        roundUsed[roundId] = true;
        roundOpen = true;
        currentRoundId = roundId;
        version = 1;
        pot = amount;
        _participantIds = participantIds;
        _payoutAddresses = payoutAddresses;
        delete _allocations;
        _allocations.push(amount);
        for (uint256 i = 1; i < n; i++) _allocations.push(0);

        emit RoundOpened(roundId, participantIds, payoutAddresses, amount);
        token.safeTransferFrom(desk, address(this), amount);
    }

    /// @notice Replaces the allocation of the open round. Needs the risk manager's signature.
    /// @param roundId Must be the open round.
    /// @param newVersion Must be exactly the current version + 1.
    /// @param newAllocations One entry per participant, summing exactly to the pot.
    /// @param memo Free-text reason, emitted in the event.
    /// @param riskSig Risk manager's EIP-712 signature over Reallocate(roundId, newVersion, allocations).
    function reallocate(
        uint256 roundId,
        uint256 newVersion,
        uint256[] calldata newAllocations,
        string calldata memo,
        bytes calldata riskSig
    ) external onlyDesk {
        _checkUpdate(REALLOCATE_TYPEHASH, roundId, newVersion, newAllocations, riskSig);
        version = newVersion;
        _allocations = newAllocations;
        emit Reallocated(roundId, newVersion, newAllocations, memo);
    }

    /// @notice Settles the open round: pays every participant its final allocation in one transaction.
    /// @param riskSig Risk manager's EIP-712 signature over CloseRound(roundId, newVersion, finalAllocations).
    function closeRound(
        uint256 roundId,
        uint256 newVersion,
        uint256[] calldata finalAllocations,
        bytes calldata riskSig
    ) external onlyDesk nonReentrant {
        _checkUpdate(CLOSE_TYPEHASH, roundId, newVersion, finalAllocations, riskSig);

        // Effects before interactions.
        version = newVersion;
        _allocations = finalAllocations;
        roundOpen = false;
        pot = 0;
        bytes32 stateHash = keccak256(abi.encode(roundId, finalAllocations));
        emit RoundSettled(roundId, newVersion, finalAllocations, stateHash);

        // Interactions: agents first, then the rest (index 0) to the desk.
        uint256 n = finalAllocations.length;
        for (uint256 i = 1; i < n; i++) {
            if (finalAllocations[i] > 0) token.safeTransfer(_payoutAddresses[i], finalAllocations[i]);
        }
        if (finalAllocations[0] > 0) token.safeTransfer(desk, finalAllocations[0]);
    }

    // ---------- views ----------

    /// @notice Participant ids and payout addresses of the current round.
    function participants() external view returns (bytes32[] memory ids, address[] memory payoutAddresses) {
        return (_participantIds, _payoutAddresses);
    }

    /// @notice Current allocations, one per participant.
    function allocations() external view returns (uint256[] memory) {
        return _allocations;
    }

    /// @notice EIP-712 digest the risk manager signs for a reallocation.
    function reallocateDigest(uint256 roundId, uint256 newVersion, uint256[] calldata allocs) external view returns (bytes32) {
        return _digest(REALLOCATE_TYPEHASH, roundId, newVersion, allocs);
    }

    /// @notice EIP-712 digest the risk manager signs for a close.
    function closeDigest(uint256 roundId, uint256 newVersion, uint256[] calldata allocs) external view returns (bytes32) {
        return _digest(CLOSE_TYPEHASH, roundId, newVersion, allocs);
    }

    /// @notice The EIP-712 domain separator (includes chain id and this vault's address).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------- internals ----------

    function _checkUpdate(
        bytes32 typehash,
        uint256 roundId,
        uint256 newVersion,
        uint256[] calldata allocs,
        bytes calldata riskSig
    ) private view {
        if (!roundOpen) revert NoOpenRound();
        if (roundId != currentRoundId) revert WrongRound(currentRoundId, roundId);
        if (newVersion != version + 1) revert BadVersion(version + 1, newVersion);
        if (allocs.length != _participantIds.length) revert LengthMismatch();
        uint256 total;
        for (uint256 i = 0; i < allocs.length; i++) total += allocs[i];
        if (total != pot) revert SumMismatch(pot, total);
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(_digest(typehash, roundId, newVersion, allocs), riskSig);
        if (err != ECDSA.RecoverError.NoError || signer != riskManager) revert BadRiskSignature(signer);
    }

    function _digest(bytes32 typehash, uint256 roundId, uint256 newVersion, uint256[] calldata allocs) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(typehash, roundId, newVersion, keccak256(abi.encodePacked(allocs)))));
    }
}
