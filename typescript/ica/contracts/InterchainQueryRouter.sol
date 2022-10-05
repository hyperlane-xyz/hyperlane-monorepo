// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {OwnableMulticall, Call, Callback} from "./OwnableMulticall.sol";

// ============ External Imports ============
import {Router} from "@hyperlane-xyz/app/contracts/Router.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract InterchainQueryRouter is Router, OwnableMulticall {
    enum Action {
        DISPATCH,
        RESOLVE
    }

    event QueryDispatched(
        uint32 indexed destinationDomain,
        address indexed sender
    );
    event QueryHandled(
        uint32 indexed originDomain,
        address indexed sender,
        Action indexed action
    );

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

    function query(
        uint32 _destinationDomain,
        Call[] calldata calls,
        Callback[] calldata callbacks
    ) external {
        require(
            calls.length == callbacks.length,
            "InterchainQueryRouter: calls and callbacks must be same length"
        );
        _dispatch(
            _destinationDomain,
            abi.encode(Action.DISPATCH, msg.sender, calls, callbacks)
        );
        emit QueryDispatched(_destinationDomain, msg.sender);
    }

    function _handle(
        uint32 _origin,
        bytes32, // router sender
        bytes calldata _message
    ) internal override {
        (Action action, address sender) = abi.decode(
            _message[:24],
            (Action, address)
        );
        if (action == Action.DISPATCH) {
            (Call[] memory calls, Callback[] memory callbacks) = abi.decode(
                _message[24:],
                (Call[], Callback[])
            );
            Call[] memory resolvedCalls = _call(calls, callbacks);
            _dispatch(
                _origin,
                abi.encode(Action.RESOLVE, sender, resolvedCalls)
            );
        } else if (action == Action.RESOLVE) {
            Call[] memory resolvedCalls = abi.decode(_message[24:], (Call[]));
            _proxyCalls(resolvedCalls);
        }
        emit QueryHandled(_origin, sender, action);
    }
}
