// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Call} from "../contracts/Call.sol";

interface IInterchainAccountRouter {
    function dispatch(uint32 _destinationDomain, Call[] calldata calls)
        external
        returns (uint256);

    function dispatch(
        uint32 _destinationDomain,
        address target,
        bytes calldata data
    ) external returns (uint256);

    function getInterchainAccount(uint32 _originDomain, address _sender)
        external
        view
        returns (address);
}
