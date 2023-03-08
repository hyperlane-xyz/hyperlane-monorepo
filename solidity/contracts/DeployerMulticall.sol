// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {CallLib} from "./libs/Call.sol";

/*
 * @title DeployerMulticall
 * @dev Permits deployer address to execute state mutating calls with value to other contracts
 */
contract DeployerMulticall {
    address public immutable deployer;

    constructor() {
        deployer = msg.sender;
    }

    modifier onlyDeployer() {
        require(msg.sender == deployer);
        _;
    }

    function proxyCalls(CallLib.Call[] calldata calls) external onlyDeployer {
        return CallLib.multicall(calls);
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
