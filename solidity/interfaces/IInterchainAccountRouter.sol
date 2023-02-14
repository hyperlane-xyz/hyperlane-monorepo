// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {CallLib} from "../contracts/libs/Call.sol";

interface IInterchainAccountRouter {
    function callRemote(
        uint32 _destinationDomain,
        CallLib.Call[] calldata calls
    ) external returns (bytes32);

    function callRemote(
        uint32 _destinationDomain,
        bytes32 _destinationRouter,
        bytes32 _destinationIsm,
        CallLib.Call[] calldata calls
    ) external returns (bytes32);

    function getLocalInterchainAccount(
        uint32 _origin,
        address _sender,
        address ism
    ) external view returns (address payable);

    function getRemoteInterchainAccount(
        uint32 _destinationDomain,
        address _sender
    ) external view returns (address);

    function getRemoteInterchainAccount(
        uint32 _destinationDomain,
        bytes32 _destinationRouter,
        bytes32 _destinationIsm,
        address _sender
    ) external view returns (address);
}
