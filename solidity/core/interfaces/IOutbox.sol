// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {ICommon} from "./ICommon.sol";

interface IOutbox is ICommon {
    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external returns (uint256);

    function checkpoint() external;

    function isCheckpoint(
        bytes32 _root,
        uint256 _index
    ) external returns (bool);

    function fail() external;
}
