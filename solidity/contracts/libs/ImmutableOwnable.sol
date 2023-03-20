// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/*
 * @title ImmutableOwnable
 * @dev Permits immutable owner address to execute calls with value to other contracts.
 */
abstract contract ImmutableOwnable {
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "!owner");
        _;
    }
}
