// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only Chainlink-shaped feed with a settable answer and a reverting mode.
contract MockFeed {
    int256 public answer;
    bool public shouldRevert;
    uint80 private round;

    constructor(int256 answer_) {
        answer = answer_;
        round = 1;
    }

    function setAnswer(int256 a) external {
        answer = a;
        round++;
    }

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "feed: not whitelisted");
        return (round, answer, block.timestamp, block.timestamp, round);
    }
}
