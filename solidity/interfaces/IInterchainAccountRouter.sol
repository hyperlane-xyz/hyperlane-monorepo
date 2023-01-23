// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {CallLib} from "../contracts/libs/Call.sol";

interface IInterchainAccountRouter {
    function dispatch(uint32 _destinationDomain, CallLib.Call[] calldata calls)
        external
        payable
        returns (bytes32);

    function dispatch(
        uint32 _destinationDomain,
        address target,
        bytes calldata data
    ) external payable returns (bytes32);

    function getInterchainAccount(uint32 _originDomain, address _sender)
        external
        view
        returns (address);
}
