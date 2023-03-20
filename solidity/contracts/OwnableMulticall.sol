// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {CallLib} from "./libs/Call.sol";
import {ImmutableOwnable} from "./libs/ImmutableOwnable.sol";

/*
 * @title OwnableMulticall
 * @dev Permits immutable owner address to execute calls with value to other contracts.
 */
contract OwnableMulticall is ImmutableOwnable {
    constructor(address _owner) ImmutableOwnable(_owner) {}

    function multicall(CallLib.Call[] calldata calls) external onlyOwner {
        return CallLib.multicall(calls);
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
