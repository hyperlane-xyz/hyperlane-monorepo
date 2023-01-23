// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {CallLib} from "../contracts/libs/Call.sol";

interface IInterchainQueryRouter {
    function query(
        uint32 _destinationDomain,
        address target,
        bytes calldata queryData,
        bytes calldata callback
    ) external payable returns (bytes32);

    function query(
        uint32 _destinationDomain,
        CallLib.Call calldata call,
        bytes calldata callback
    ) external payable returns (bytes32);

    function query(
        uint32 _destinationDomain,
        CallLib.Call[] calldata calls,
        bytes[] calldata callbacks
    ) external payable returns (bytes32);
}
