// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {CallLib} from "../libs/Call.sol";
import {Router} from "../Router.sol";
import {IInterchainQueryRouter} from "../../interfaces/IInterchainQueryRouter.sol";
import {InterchainCallMessage} from "./InterchainCallMessage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title Interchain Query Router that performs remote view calls on other chains and returns the result.
 * @dev Currently does not support Sovereign Consensus (user specified Interchain Security Modules).
 */
contract InterchainQueryRouter is Router, IInterchainQueryRouter {
    using CallLib for CallLib.StaticCallWithCallback[];
    using CallLib for bytes[];

    using InterchainCallMessage for CallLib.StaticCall[];
    using InterchainCallMessage for CallLib.StaticCallWithCallback[];
    using InterchainCallMessage for bytes[];
    using InterchainCallMessage for bytes;

    using TypeCasts for address;
    using TypeCasts for bytes32;

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
    event QueryReturned(uint32 indexed originDomain, bytes32 indexed sender);
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

    function query(
        uint32 _destinationDomain,
        CallLib.StaticCallWithCallback[] calldata calls
    ) public returns (bytes32 messageId) {
        emit QueryDispatched(_destinationDomain, msg.sender);
        messageId = _dispatch(
            _destinationDomain,
            InterchainCallMessage.format(calls, msg.sender.addressToBytes32())
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
        InterchainCallMessage.CallType calltype = _message.calltype();
        bytes32 sender = _message.sender();
        if (
            calltype == InterchainCallMessage.CallType.STATIC_CALL_WITH_CALLBACK
        ) {
            emit QueryReturned(_origin, sender);
            bytes[] memory callbacks = _message
                .callsWithCallbacks()
                .multistaticcall();
            _dispatch(_origin, callbacks.format(sender));
        } else if (calltype == InterchainCallMessage.CallType.RAW_CALLDATA) {
            address senderAddress = sender.bytes32ToAddress();
            emit QueryResolved(_origin, senderAddress);
            _message.rawCalls().multicallto(senderAddress);
        } else {
            assert(false);
        }
    }
}
