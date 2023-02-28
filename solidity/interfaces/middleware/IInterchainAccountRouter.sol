// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {OwnableMulticall} from "../../contracts/OwnableMulticall.sol";
import {CallLib} from "../../contracts/libs/Call.sol";

interface IInterchainAccountRouter {
    function callRemote(
        uint32 _destinationDomain,
        CallLib.Call[] calldata calls
    ) external returns (bytes32);

    function callRemoteWithOverrides(
        uint32 _destinationDomain,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata calls
    ) external returns (bytes32);

    function getLocalInterchainAccount(
        uint32 _origin,
        bytes32 _router,
        bytes32 _sender,
        address _ism
    ) external view returns (OwnableMulticall);

    function getLocalInterchainAccount(
        uint32 _origin,
        address _router,
        address _sender,
        address _ism
    ) external view returns (OwnableMulticall);
}
