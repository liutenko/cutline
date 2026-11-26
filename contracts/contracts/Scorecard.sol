// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Chainlink AggregatorV3 read interface (Atlas feeds are compatible).
interface IAggregator {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title Scorecard
/// @notice Verifiable track record for AI trading agents run by a desk. Holds no funds.
contract Scorecard {
    struct Agent {
        string name;
        address agentAddr;
        string strategy;
        bool exists;
    }

    struct Record {
        uint32 roundsPlayed;
        uint32 roundsFunded;
        uint32 timesCut;
        int256 cumulativePnlBps;
        int256 bestPnlBps;
        uint256 lastRoundId;
    }

    address public immutable operator;

    mapping(bytes32 => Agent) private agents;
    mapping(bytes32 => Record) private records;
    mapping(uint256 => bool) private closed;
    bytes32[] private agentIds;

    event AgentRegistered(bytes32 indexed agentId, string name, address agentAddr, string strategy);
    event RoundClosed(uint256 indexed roundId, bytes32 stateHash, uint256 timestamp);
    event AgentResult(uint256 indexed roundId, bytes32 indexed agentId, int256 pnlBps, uint8 status);
    event PriceStamp(
        uint256 indexed roundId,
        address indexed feed,
        int256 onchainAnswer,
        uint256 updatedAt,
        int256 offchainPrice,
        bool readOk
    );

    error NotOperator();
    error RoundAlreadyClosed(uint256 roundId);
    error LengthMismatch();
    error UnknownAgent(bytes32 agentId);
    error BadStatus(uint8 status);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_) {
        operator = operator_;
    }

    /// @notice Register an agent, or update the name and strategy of an existing one.
    function registerAgent(bytes32 agentId, string calldata name, address agentAddr, string calldata strategy)
        external
        onlyOperator
    {
        Agent storage a = agents[agentId];
        if (!a.exists) {
            a.exists = true;
            agentIds.push(agentId);
        }
        a.name = name;
        a.agentAddr = agentAddr;
        a.strategy = strategy;
        emit AgentRegistered(agentId, name, agentAddr, strategy);
    }

    /// @notice Close a round: update each agent's record, stamp feed prices, link the settlement hash.
    /// @param status 0 evaluating, 1 funded, 2 cut.
    /// @param stateHash Hash of the final settlement allocation.
    /// @param feeds Oracle feeds to read (failures never revert the call).
    /// @param offchainPrices Price the engine read off-chain for each feed.
    function closeRound(
        uint256 roundId,
        bytes32[] calldata ids,
        int256[] calldata pnlBps,
        uint8[] calldata status,
        bytes32 stateHash,
        address[] calldata feeds,
        int256[] calldata offchainPrices
    ) external onlyOperator {
        if (closed[roundId]) revert RoundAlreadyClosed(roundId);
        if (ids.length != pnlBps.length || ids.length != status.length || feeds.length != offchainPrices.length) {
            revert LengthMismatch();
        }
        closed[roundId] = true;

        for (uint256 i = 0; i < ids.length; i++) {
            if (!agents[ids[i]].exists) revert UnknownAgent(ids[i]);
            if (status[i] > 2) revert BadStatus(status[i]);
            Record storage r = records[ids[i]];
            if (r.roundsPlayed == 0 || pnlBps[i] > r.bestPnlBps) r.bestPnlBps = pnlBps[i];
            r.roundsPlayed++;
            if (status[i] == 1) r.roundsFunded++;
            if (status[i] == 2) r.timesCut++;
            r.cumulativePnlBps += pnlBps[i];
            r.lastRoundId = roundId;
            emit AgentResult(roundId, ids[i], pnlBps[i], status[i]);
        }

        _stampFeeds(roundId, feeds, offchainPrices);

        emit RoundClosed(roundId, stateHash, block.timestamp);
    }

    /// @dev Low-level staticcall so that reverts, short returns and feeds without code never revert closeRound.
    function _stampFeeds(uint256 roundId, address[] calldata feeds, int256[] calldata offchainPrices) internal {
        for (uint256 j = 0; j < feeds.length; j++) {
            (bool ok, bytes memory ret) =
                feeds[j].staticcall(abi.encodeWithSelector(IAggregator.latestRoundData.selector));
            if (ok && ret.length >= 160) {
                (, int256 answer,, uint256 updatedAt,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
                emit PriceStamp(roundId, feeds[j], answer, updatedAt, offchainPrices[j], true);
            } else {
                emit PriceStamp(roundId, feeds[j], 0, 0, offchainPrices[j], false);
            }
        }
    }

    /// @notice Registered details of an agent.
    function getAgent(bytes32 agentId)
        external
        view
        returns (string memory name, address agentAddr, string memory strategy, bool exists)
    {
        Agent storage a = agents[agentId];
        return (a.name, a.agentAddr, a.strategy, a.exists);
    }

    /// @notice Cumulative record of an agent.
    function getRecord(bytes32 agentId) external view returns (Record memory) {
        return records[agentId];
    }

    /// @notice Whether a round has been closed.
    function roundClosed(uint256 roundId) external view returns (bool) {
        return closed[roundId];
    }

    /// @notice Number of registered agents.
    function agentCount() external view returns (uint256) {
        return agentIds.length;
    }

    /// @notice Agent id at index i.
    function agentIdAt(uint256 i) external view returns (bytes32) {
        return agentIds[i];
    }
}
