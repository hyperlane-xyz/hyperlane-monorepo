// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {CallLib} from "../libs/Call.sol";

// A PI version of ICAs in which ICAs are tightly coupled to the
// ISM that secures them.
abstract contract Type2InterchainAccountRouter {
    struct DefaultConfig {
        bytes32 router;
        bytes32 ism;
    }

    // Maps destination domain to default config
    mapping(uint32 => DefaultConfig) defaults;

    // onlyOwner. Once defaults are set for a destination domain, those defaults can never
    // be modified.
    function setImmutableDefaults(
        uint32 _destinationDomain,
        bytes32 _defaultRouter,
        bytes32 _defaultIsm
    ) external virtual;

    // Fails if entry for _destinationDomain not present in defaults
    function callRemote(
        uint32 _destinationDomain,
        CallLib.Call[] calldata calls
    ) external virtual returns (bytes32);

    // PI alternative where defaults are bypassed
    function callRemote(
        uint32 _destinationDomain,
        bytes32 _destinationRouter,
        bytes32 _destinationIsm,
        CallLib.Call[] calldata calls
    ) external virtual returns (bytes32);

    // Returns the address of the interchain account deployed on the current chain
    function getLocalInterchainAccount(
        uint32 _origin,
        address _sender,
        address ism
    ) public view virtual returns (address);

    // Returns the address of the interchain account deployed on a remote chain, per
    // the defaults (fails if no defaults for `_destination`)
    function getRemoteInterchainAccount(
        uint32 _destinationDomain,
        address _sender
    ) public view virtual returns (address);

    // Returns the address of the interchain account deployed on a remote chain
    function getRemoteInterchainAccount(
        uint32 _destinationDomain,
        bytes32 _destinationRouter,
        bytes32 _destinationIsm,
        address _sender
    ) public view virtual returns (address);
}
