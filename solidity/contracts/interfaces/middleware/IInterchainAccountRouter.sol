// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {OwnableMulticall} from "../../OwnableMulticall.sol";
import {CallLib} from "../../libs/Call.sol";

interface IInterchainAccountRouter {
    function callRemote(
        uint32 _destination,
        address _to,
        uint256 _value,
        bytes calldata _data
    ) external returns (bytes32);

    function callRemote(uint32 _destination, CallLib.Call[] calldata calls)
        external
        returns (bytes32);

    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata calls
    ) external returns (bytes32);

    function getLocalInterchainAccount(
        uint32 _origin,
        bytes32 _router,
        bytes32 _owner,
        address _ism
    ) external view returns (OwnableMulticall);

    function getLocalInterchainAccount(
        uint32 _origin,
        address _router,
        address _owner,
        address _ism
    ) external view returns (OwnableMulticall);

    function getRemoteInterchainAccount(
        address _router,
        address _owner,
        address _ism
    ) external view returns (address);

    function getRemoteInterchainAccount(uint32 _destination, address _owner)
        external
        view
        returns (address);
}
