// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {CallLib} from "../libs/Call.sol";
import {GasRouter} from "../GasRouter.sol";
import {IInterchainQueryRouter} from "../../interfaces/IInterchainQueryRouter.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title Interchain Query Router that performs remote view calls on other chains and returns the result.
 * @dev Currently does not support Sovereign Consensus (user specified Interchain Security Modules).
 */
contract InterchainQueryRouter is GasRouter, IInterchainQueryRouter {
    using CallLib for address;
    using CallLib for CallLib.Call[];

    enum Action {
        DISPATCH,
        RESOLVE
    }

    /**
     * @notice Emitted when a query is dispatched to another chain.
     * @param destinationDomain The domain of the chain to query.
     * @param sender The address that dispatched the query.
     */
    event QueryDispatched(
        uint32 indexed destinationDomain,
        address indexed sender
    );
    /**
     * @notice Emitted when a query is returned to the origin chain.
     * @param originDomain The domain of the chain to return the result to.
     * @param sender The address to receive the result.
     */
    event QueryReturned(uint32 indexed originDomain, address indexed sender);
    /**
     * @notice Emitted when a query is resolved on the origin chain.
     * @param destinationDomain The domain of the chain that was queried.
     * @param sender The address that resolved the query.
     */
    event QueryResolved(
        uint32 indexed destinationDomain,
        address indexed sender
    );

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
    ) external payable returns (bytes32 messageId) {
        // TODO: fix this ugly arrayification
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.Call({to: target, data: queryData});
        bytes[] memory callbacks = new bytes[](1);
        callbacks[0] = callback;
        messageId = query(_destinationDomain, calls, callbacks);
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
    ) external payable returns (bytes32 messageId) {
        // TODO: fix this ugly arrayification
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;
        bytes[] memory callbacks = new bytes[](1);
        callbacks[0] = callback;
        messageId = query(_destinationDomain, calls, callbacks);
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param calls Array of calls (to and data packed struct) to be made on destination chain in sequence.
     * @param callbacks Array of callback function selectors on `msg.sender` and optionally abi-encoded prefix arguments.
     */
    function query(
        uint32 _destinationDomain,
        CallLib.Call[] memory calls,
        bytes[] memory callbacks
    ) public payable returns (bytes32 messageId) {
        require(
            calls.length == callbacks.length,
            "InterchainQueryRouter: calls and callbacks must be same length"
        );
        bytes memory body = abi.encode(
            Action.DISPATCH,
            msg.sender,
            calls,
            callbacks
        );
        messageId = _dispatchWithGas(_destinationDomain, body);
        emit QueryDispatched(_destinationDomain, msg.sender);
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
        Action action = Action(uint8(bytes1(_message[31])));
        if (action == Action.DISPATCH) {
            (
                ,
                address sender,
                CallLib.Call[] memory calls,
                bytes[] memory callbacks
            ) = abi.decode(
                    _message,
                    (Action, address, CallLib.Call[], bytes[])
                );
            callbacks = calls._multicallAndResolve(callbacks);
            bytes memory body = abi.encode(Action.RESOLVE, sender, callbacks);
            // WARN: return route does not currently pay for gas
            _dispatch(_origin, body);
            emit QueryReturned(_origin, sender);
        } else if (action == Action.RESOLVE) {
            (, address sender, bytes[] memory resolveCallbacks) = abi.decode(
                _message,
                (Action, address, bytes[])
            );
            sender._multicall(resolveCallbacks);
            emit QueryResolved(_origin, sender);
        }
    }
}
