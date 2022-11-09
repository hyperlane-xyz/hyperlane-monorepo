// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Call} from "../contracts/OwnableMulticall.sol";

interface IInterchainQueryRouter {
    function query(
        uint32 _destinationDomain,
        Call calldata call,
        bytes calldata callback
    ) external returns (uint256);

    function query(
        uint32 _destinationDomain,
        Call[] calldata calls,
        bytes[] calldata callbacks
    ) external returns (uint256);
}
