// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {CallLib} from "./libs/Call.sol";

/*
 * @title OwnableMulticall
 * @dev Permits owner address to execute stateful calls with value to other contracts
 */
contract OwnableMulticall is OwnableUpgradeable {
    using CallLib for CallLib.Call[];

    constructor() {
        _transferOwnership(msg.sender);
    }

    function initialize() external initializer {
        __Ownable_init();
    }

    function proxyCalls(CallLib.Call[] calldata calls) external onlyOwner {
        return calls.multicall();
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
