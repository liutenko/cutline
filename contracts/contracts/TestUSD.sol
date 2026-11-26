// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Cutline Test USD (tUSD)
/// @notice A test stablecoin for the BNB Smart Chain testnet demo. It has no value and no backing.
///         It exists only so the desk's pot in DeskVault has an asset to hold on testnet.
/// @dev 6 decimals, like USDT/USDC elsewhere. Only the owner can mint.
contract TestUSD is ERC20, Ownable {
    constructor(address owner_) ERC20("Cutline Test USD", "tUSD") Ownable(owner_) {}

    /// @notice tUSD uses 6 decimals.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints test tokens. Owner only.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
