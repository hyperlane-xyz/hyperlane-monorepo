// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Router} from "../client/Router.sol";
import {CallLib} from "./libs/Call.sol";
import {InterchainQueryMessage} from "./libs/InterchainQueryMessage.sol";

/**
 * @title Interchain Query Router that performs remote view calls on other chains and returns the result.
 * @dev Currently does not support Sovereign Consensus (user specified Interchain Security Modules).
 */
contract InterchainQueryRouter is Router {
    using TypeCasts for address;
    using TypeCasts for bytes32;
    using InterchainQueryMessage for bytes;

    /**
     * @notice Emitted when a query is dispatched to another chain.
     * @param destination The domain of the chain to query.
     * @param sender The address that dispatched the query.
     */
    event QueryDispatched(uint32 indexed destination, address indexed sender);
    /**
     * @notice Emitted when a query is executed on the and callback dispatched to the origin chain.
     * @param originDomain The domain of the chain that dispatched the query and receives the callback.
     * @param sender The address to receive the result.
     */
    event QueryExecuted(uint32 indexed originDomain, bytes32 indexed sender);
    /**
     * @notice Emitted when a query is resolved on the origin chain.
     * @param destination The domain of the chain that was queried.
     * @param sender The address that resolved the query.
     */
    event QueryResolved(uint32 indexed destination, address indexed sender);

    constructor(address _mailbox) Router(_mailbox) {}

    /**
     * @notice Initializes the Router contract with Hyperlane core contracts and the address of the interchain security module.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _interchainSecurityModule The address of the interchain security module contract.
     * @param _owner The address with owner privileges.
     */
    function initialize(
        address _interchainGasPaymaster,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        _MailboxClient_initialize(
            _interchainGasPaymaster,
            _interchainSecurityModule,
            _owner
        );
    }

    /**
     * @notice Dispatches a sequence of static calls (query) to the destination domain and set of callbacks to resolve the results on the dispatcher.
     * @param _destination The domain of the chain to query.
     * @param _to The address of the contract to query
     * @param _data The calldata encoding the query
     * @param _callback The calldata of the callback that will be made on the sender.
     * The return value of the query will be appended.
     * @dev Callbacks must be returned to the `msg.sender` for security reasons. Require this contract is the `msg.sender` on callbacks.
     */
    function query(
        uint32 _destination,
        address _to,
        bytes memory _data,
        bytes memory _callback
    ) public returns (bytes32 messageId) {
        emit QueryDispatched(_destination, msg.sender);

        messageId = _dispatch(
            _destination,
            InterchainQueryMessage.encode(
                msg.sender.addressToBytes32(),
                _to,
                _data,
                _callback
            )
        );
    }

    /**
     * @notice Dispatches a sequence of static calls (query) to the destination domain and set of callbacks to resolve the results on the dispatcher.
     * @param _destination The domain of the chain to query.
     * @param calls The sequence of static calls to dispatch and callbacks on the sender to resolve the results.
     * @dev Recommend using CallLib.build to format the interchain calls.
     * @dev Callbacks must be returned to the `msg.sender` for security reasons. Require this contract is the `msg.sender` on callbacks.
     */
    function query(
        uint32 _destination,
        CallLib.StaticCallWithCallback[] calldata calls
    ) public returns (bytes32 messageId) {
        emit QueryDispatched(_destination, msg.sender);
        messageId = _dispatch(
            _destination,
            InterchainQueryMessage.encode(msg.sender.addressToBytes32(), calls)
        );
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
        InterchainQueryMessage.MessageType messageType = _message.messageType();
        bytes32 sender = _message.sender();
        if (messageType == InterchainQueryMessage.MessageType.QUERY) {
            CallLib.StaticCallWithCallback[]
                memory callsWithCallback = InterchainQueryMessage
                    .callsWithCallbacks(_message);
            bytes[] memory callbacks = CallLib.multistaticcall(
                callsWithCallback
            );
            emit QueryExecuted(_origin, sender);
            _dispatch(
                _origin,
                InterchainQueryMessage.encode(sender, callbacks)
            );
        } else if (messageType == InterchainQueryMessage.MessageType.RESPONSE) {
            address senderAddress = sender.bytes32ToAddress();
            bytes[] memory rawCalls = _message.rawCalls();
            CallLib.multicallto(senderAddress, rawCalls);
            emit QueryResolved(_origin, senderAddress);
        } else {
            assert(false);
        }
    }
}
