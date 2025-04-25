// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IRegistry} from "./common/IRegistry.sol";

interface IOperatorRegistry is IRegistry {
    error OperatorAlreadyRegistered();

    /**
     * @notice Register the caller as an operator.
     */
    function registerOperator() external;
}
