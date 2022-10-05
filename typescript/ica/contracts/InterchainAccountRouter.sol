// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {OwnableMulticall, Call} from "./OwnableMulticall.sol";

// ============ External Imports ============
import {Router} from "@hyperlane-xyz/app/contracts/Router.sol";
import {TypeCasts} from "@hyperlane-xyz/core/contracts/libs/TypeCasts.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/*
 * @title The Hello World App
 * @dev You can use this simple app as a starting point for your own application.
 */
contract InterchainAccountRouter is Router {
    bytes constant bytecode = type(OwnableMulticall).creationCode;
    bytes32 constant bytecodeHash = bytes32(keccak256(bytecode));

    function initialize(
        address _owner,
        address _abacusConnectionManager,
        address _interchainGasPaymaster
    ) public initializer {
        // Transfer ownership of the contract to deployer
        _transferOwnership(_owner);
        // Set the addresses for the ACM and IGP
        // Alternatively, this could be done later in an initialize method
        _setAbacusConnectionManager(_abacusConnectionManager);
        _setInterchainGasPaymaster(_interchainGasPaymaster);
    }

    function dispatch(uint32 _destinationDomain, Call[] calldata calls)
        external
    {
        _dispatch(_destinationDomain, abi.encode(msg.sender, calls));
    }

    function getInterchainAccount(uint32 _origin, address _sender)
        public
        view
        returns (address)
    {
        return _getInterchainAccount(_salt(_origin, _sender));
    }

    function getDeployedInterchainAccount(uint32 _origin, address _sender)
        public
        returns (OwnableMulticall)
    {
        bytes32 salt = _salt(_origin, _sender);
        address interchainAccount = _getInterchainAccount(salt);
        if (!Address.isContract(interchainAccount)) {
            interchainAccount = Create2.deploy(0, salt, bytecode);
        }
        return OwnableMulticall(interchainAccount);
    }

    function _salt(uint32 _origin, address _sender)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(abi.encodePacked(_origin, _sender));
    }

    function _getInterchainAccount(bytes32 salt)
        internal
        view
        returns (address)
    {
        return Create2.computeAddress(salt, bytecodeHash);
    }

    function _handle(
        uint32 _origin,
        bytes32, // router sender
        bytes memory _message
    ) internal override {
        (address sender, Call[] memory calls) = abi.decode(
            _message,
            (address, Call[])
        );
        getDeployedInterchainAccount(_origin, sender).proxyCalls(calls);
    }
}
