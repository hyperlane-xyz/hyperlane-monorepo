// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {OwnableMulticall, Call} from "./OwnableMulticall.sol";

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
    event QueryReturned(uint32 indexed originDomain, address indexed sender);
    event QueryResolved(
        uint32 indexed destinationDomain,
        address indexed sender
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

    /**
     * @param _destinationDomain Domain of destination chain
     * @param call Call (to and data packed struct) to be made on destination chain.
     * @param callback Callback function selector on `msg.sender` and optionally abi-encoded prefix arguments.
     */
    function query(
        uint32 _destinationDomain,
        Call calldata call,
        bytes calldata callback
    ) external {
        Call[] memory calls = new Call[](1);
        calls[0] = call;
        bytes[] memory callbacks = new bytes[](1);
        callbacks[0] = callback;
        query(_destinationDomain, calls, callbacks);
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param calls Array of calls (to and data packed struct) to be made on destination chain in sequence.
     * @param callbacks Array of callback function selectors on `msg.sender` and optionally abi-encoded prefix arguments.
     */
    function query(
        uint32 _destinationDomain,
        Call[] memory calls,
        bytes[] memory callbacks
    ) public {
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
            _message,
            (Action, address)
        );
        if (action == Action.DISPATCH) {
            (, , Call[] memory calls, bytes[] memory callbacks) = abi.decode(
                _message,
                (Action, address, Call[], bytes[])
            );
            bytes[] memory resolveCallbacks = _call(calls, callbacks);
            _dispatch(
                _origin,
                abi.encode(Action.RESOLVE, sender, resolveCallbacks)
            );
            emit QueryReturned(_origin, sender);
        } else if (action == Action.RESOLVE) {
            (, , bytes[] memory resolveCallbacks) = abi.decode(
                _message,
                (Action, address, bytes[])
            );
            proxyCallBatch(sender, resolveCallbacks);
            emit QueryResolved(_origin, sender);
        }
    }
}
