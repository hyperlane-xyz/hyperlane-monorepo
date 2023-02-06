// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {CallLib} from "../contracts/libs/Call.sol";

interface IInterchainAccountRouter {
    function dispatch(uint32 _destinationDomain, CallLib.Call[] calldata calls)
        external
        returns (bytes32);

    function getInterchainAccount(uint32 _originDomain, bytes32 _sender)
        external
        view
        returns (address payable);
}
