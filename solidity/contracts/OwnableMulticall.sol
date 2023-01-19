// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {CallLib} from "./libs/Call.sol";

/*
 * @title OwnableMulticall
 * @dev Allows only only address to execute calls to other contracts
 */
contract OwnableMulticall is OwnableUpgradeable {
    using CallLib for CallLib.Call[];
    using CallLib for CallLib.CallWithValue[];

    constructor() {
        _transferOwnership(msg.sender);
    }

    function initialize() external initializer {
        __Ownable_init();
    }

    function proxyCalls(CallLib.Call[] calldata calls) external onlyOwner {
        return calls.multicall();
    }

    function proxyCallsWithValue(CallLib.CallWithValue[] calldata calls)
        external
        onlyOwner
    {
        return calls.multicall();
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
