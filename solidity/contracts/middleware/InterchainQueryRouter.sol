// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {CallLib} from "../libs/Call.sol";
import {Router} from "../Router.sol";
import {IInterchainQueryRouter} from "../../interfaces/IInterchainQueryRouter.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

enum QueryAction {
    DISPATCH,
    RESOLVE
}

library IqsMessage {
    function format(CallLib.CallWithCallback[] memory calls)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(QueryAction.DISPATCH, calls);
    }

    function format(CallLib.Call[] memory callbacks)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(QueryAction.RESOLVE, callbacks);
    }

    function action(bytes calldata _message)
        internal
        pure
        returns (QueryAction)
    {
        return QueryAction(uint8(bytes1(_message[31])));
    }

    function rawCalls(bytes calldata _message)
        internal
        pure
        returns (bytes calldata)
    {
        return _message[32:];
    }
}

/**
 * @title Interchain Query Router that performs remote view calls on other chains and returns the result.
 * @dev Currently does not support Sovereign Consensus (user specified Interchain Security Modules).
 */
contract InterchainQueryRouter is Router, IInterchainQueryRouter {
    using CallLib for CallLib.Call[];
    using CallLib for CallLib.CallWithCallback[];

    using IqsMessage for CallLib.CallWithCallback[];
    using IqsMessage for CallLib.Call[];
    using IqsMessage for bytes;

    /**
     * @notice Emitted when a query is dispatched to another chain.
     * @param destinationDomain The domain of the chain to query.
     * @param queryId The id of the message that dispatched the query.
     */
    event QueryDispatched(
        uint32 indexed destinationDomain,
        bytes32 indexed queryId
    );
    /**
     * @notice Emitted when a query is returned to the origin chain.
     * @param originDomain The domain of the chain to return the result to.
     * @param queryId The id of the message that dispatched the query.
     */
    event QueryReturned(uint32 indexed originDomain, bytes32 indexed queryId);
    /**
     * @notice Emitted when a query is resolved on the origin chain.
     * @param destinationDomain The domain of the chain that was queried.
     */
    event QueryResolved(uint32 indexed destinationDomain);

    /**
     * @notice Initializes the Router contract with Hyperlane core contracts and the address of the interchain security module.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _interchainSecurityModule The address of the interchain security module contract.
     * @param _owner The address with owner privileges.
     */
    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule,
            _owner
        );
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param target The address of the contract to query on destination chain.
     * @param queryData The calldata of the view call to make on the destination chain.
     * @param callback Callback function selector on `msg.sender` and optionally abi-encoded prefix arguments.
     * @return messageId The ID of the message encoding the query.
     */
    function query(
        uint32 _destinationDomain,
        address target,
        bytes calldata queryData,
        bytes calldata callback
    ) external returns (bytes32 messageId) {
        messageId = this.query(
            _destinationDomain,
            CallLib.Call(target, queryData),
            callback
        );
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param call Call (to and data packed struct) to be made on destination chain.
     * @param callback Callback function selector on `msg.sender` and optionally abi-encoded prefix arguments.
     */
    function query(
        uint32 _destinationDomain,
        CallLib.Call calldata call,
        bytes calldata callback
    ) public returns (bytes32 messageId) {
        CallLib.CallWithCallback[]
            memory calls = new CallLib.CallWithCallback[](1);
        calls[0] = CallLib.CallWithCallback(
            call,
            CallLib.Call({to: msg.sender, data: callback})
        );
        messageId = this.query(_destinationDomain, calls);
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param calls Array of calls (to and data packed struct) to be made on destination chain in sequence.
     */
    function query(
        uint32 _destinationDomain,
        CallLib.Call[] memory calls,
        bytes[] memory callbacks
    ) public returns (bytes32 messageId) {
        CallLib.CallWithCallback[]
            memory callsWithCallbacks = new CallLib.CallWithCallback[](
                calls.length
            );
        for (uint256 i = 0; i < calls.length; i++) {
            callsWithCallbacks[i] = CallLib.CallWithCallback(
                calls[i],
                CallLib.Call({to: msg.sender, data: callbacks[i]})
            );
        }
        messageId = _dispatch(_destinationDomain, callsWithCallbacks.format());
        emit QueryDispatched(_destinationDomain, messageId);
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param calls Array of calls (to and data packed struct) to be made on destination chain in sequence.
     */
    function query(
        uint32 _destinationDomain,
        CallLib.CallWithCallback[] memory calls
    ) public returns (bytes32 messageId) {
        messageId = _dispatch(_destinationDomain, calls.format());
        emit QueryDispatched(_destinationDomain, messageId);
    }

    /**
     * @notice Handles a message from remote enrolled Interchain Query Router.
     * @param _origin The domain of the chain that sent the message.
     * @param _message The ABI-encoded interchain query.
     */
    function _handle(
        uint32 _origin,
        bytes32, // router sender
        bytes calldata _message
    ) internal override {
        QueryAction action = _message.action();
        if (action == QueryAction.DISPATCH) {
            CallLib.CallWithCallback[] memory calls = abi.decode(
                _message.rawCalls(),
                (CallLib.CallWithCallback[])
            );
            CallLib.Call[] memory callbacks = calls.multicall();
            bytes32 messageId = _dispatch(_origin, callbacks.format());
            emit QueryReturned(_origin, messageId);
        } else if (action == QueryAction.RESOLVE) {
            CallLib.Call[] memory callbacks = abi.decode(
                _message.rawCalls(),
                (CallLib.Call[])
            );
            callbacks.multicall();
            emit QueryResolved(_origin);
        }
    }
}
