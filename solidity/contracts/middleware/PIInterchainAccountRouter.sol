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

// A PI version of ICAs in which ICAs must be initialized before they
// are owned.
abstract contract Type3InterchainAccountRouter {
    struct DefaultConfig {
        bytes32 router;
        bytes32 ism;
    }

    struct OwnerConfig {
        uint32 originDomain;
        bytes32 originOwner;
        bytes32 commitment;
    }

    // Maps destination domain to default config
    mapping(uint32 => DefaultConfig) defaults;
    // Maps ICA address to remote owner
    mapping(address => OwnerConfig) owners;

    // onlyOwner. Defaults can be mutable
    function setDefaults(
        uint32 _destinationDomain,
        bytes32 _defaultRouter,
        bytes32 _defaultIsm
    ) external virtual;

    // Creates a new ICA owned by (_originDomain, _originOwner) and secured by _ism.
    // Adds an entry to `owners` and returns the address
    function createLocalInterchainAccount(
        uint32 _originDomain,
        bytes32 _originOwner,
        address _ism
    ) public virtual returns (address);

    // Creates a new ICA owned by (localDomain, msg.sender), and secured by the
    // default configuration for _destinationDomain.
    // Reverts if no default config for _destinationDomain
    // Returns the message ID
    function createRemoteInterchainAccount(uint32 _destinationDomain)
        external
        virtual
        returns (bytes32);

    // Fails if entry for _destinationDomain not present in defaults
    function callRemote(
        uint32 _destinationDomain,
        bytes32 _interchainAccount,
        CallLib.Call[] calldata calls
    ) external virtual returns (bytes32);

    // PI alternative where defaults are bypassed
    function callRemote(
        uint32 _destinationDomain,
        bytes32 _destinationRouter,
        bytes32 _interchainAccount,
        CallLib.Call[] calldata calls
    ) external virtual returns (bytes32);

    // Returns the owner of the interchain account deployed on the current chain
    function getInterchainAccountOwner(address account)
        public
        view
        virtual
        returns (uint32, bytes32);

    // Returns whether or not an account is owned by the provided origin domain/owner
    function isInterchainAccountOwner(
        address account,
        uint32 originDomain,
        bytes32 owner
    ) public view virtual returns (bool);
}
