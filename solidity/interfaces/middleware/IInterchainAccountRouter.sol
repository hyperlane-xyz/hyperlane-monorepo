// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {OwnableMulticall} from "../../contracts/OwnableMulticall.sol";
import {CallLib} from "../../contracts/libs/Call.sol";

interface IInterchainAccountRouter {
    struct InterchainAccountConfig {
        bytes32 router;
        bytes32 ism;
    }

    function callRemote(
        uint32 _destinationDomain,
        CallLib.Call[] calldata calls
    ) external returns (bytes32);

    function callRemote(
        uint32 _destinationDomain,
        InterchainAccountConfig calldata _config,
        CallLib.Call[] calldata calls
    ) external returns (bytes32);

    function getLocalInterchainAccount(
        uint32 _origin,
        bytes32 _sender,
        address _ism
    ) external view returns (OwnableMulticall);

    function getLocalInterchainAccount(
        uint32 _origin,
        address _sender,
        address _ism
    ) external view returns (OwnableMulticall);
}
