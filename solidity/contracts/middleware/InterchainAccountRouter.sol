// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {OwnableMulticall} from "../OwnableMulticall.sol";
import {Router} from "../Router.sol";
import {IInterchainAccountRouter} from "../../interfaces/IInterchainAccountRouter.sol";
import {InterchainCallMessage} from "./InterchainCallMessage.sol";
import {MinimalProxy} from "../libs/MinimalProxy.sol";
import {CallLib} from "../libs/Call.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/*
 * @title Interchain Accounts Router that relays messages via proxy contracts on other chains.
 * @dev Currently does not support Sovereign Consensus (user specified Interchain Security Modules).
 */
contract InterchainAccountRouter is Router, IInterchainAccountRouter {
    using InterchainCallMessage for CallLib.Call[];
    using InterchainCallMessage for CallLib.CallWithValue[];
    using InterchainCallMessage for bytes;

    address internal immutable implementation;
    bytes32 internal immutable bytecodeHash;

    /**
     * @notice Emitted when an interchain account is created (first time message is sent from a given `origin`/`sender` pair)
     * @param origin The domain of the chain where the message was sent from
     * @param sender The address of the account that sent the message
     * @param account The address of the proxy account that was created
     */
    event InterchainAccountCreated(
        uint32 indexed origin,
        address sender,
        address account
    );

    /**
     * @notice Constructor deploys a relay (OwnableMulticall.sol) contract that will be cloned for each interchain account.
     */
    constructor() {
        implementation = address(new OwnableMulticall());
        // cannot be stored immutably because it is dynamically sized
        bytes memory bytecode = MinimalProxy.bytecode(implementation);
        bytecodeHash = keccak256(bytecode);
    }

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
     * @notice Dispatches a sequence of calls to be relayed by the sender's interchain account on the destination domain.
     * @param _destinationDomain The domain of the chain where the message will be sent to.
     * @param calls The sequence of calls to be relayed.
     */
    function dispatch(uint32 _destinationDomain, CallLib.Call[] calldata calls)
        external
        returns (bytes32)
    {
        return _dispatch(_destinationDomain, calls.format(msg.sender));
    }

    /**
     * @notice Dispatches a sequence of calls to be relayed by the sender's interchain account on the destination domain.
     * @param _destinationDomain The domain of the chain where the message will be sent to.
     * @param calls The sequence of calls to be relayed.
     */
    function dispatch(
        uint32 _destinationDomain,
        CallLib.CallWithValue[] calldata calls
    ) external returns (bytes32) {
        return _dispatch(_destinationDomain, calls.format(msg.sender));
    }

    /**
     * @notice Dispatches a single call to be relayed by the sender's interchain account on the destination domain.
     * @param _destinationDomain The domain of the chain where the message will be sent to.
     * @param target The address of the contract to be called.
     * @param data The ABI-encoded data to be called on target contract.
     * @return The message ID of the dispatched message.
     */
    function dispatch(
        uint32 _destinationDomain,
        address target,
        bytes calldata data
    ) external returns (bytes32) {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.Call({to: target, data: data});
        return _dispatch(_destinationDomain, calls.format(msg.sender));
    }

    function dispatch(
        uint32 _destinationDomain,
        address target,
        bytes calldata data,
        uint256 value
    ) external returns (bytes32) {
        CallLib.CallWithValue[] memory calls = new CallLib.CallWithValue[](1);
        calls[0] = CallLib.CallWithValue(value, CallLib.Call(target, data));
        return _dispatch(_destinationDomain, calls.format(msg.sender));
    }

    /**
     * @notice Returns the address of the interchain account deployed on the current chain for a given `origin`/`sender` pair.
     * @param _origin The origin domain of the interchain account.
     * @param _sender The parent account address on the origin domain.
     * @return The address of the interchain account.
     */
    function getInterchainAccount(uint32 _origin, address _sender)
        public
        view
        returns (address payable)
    {
        return _getInterchainAccount(_salt(_origin, _sender));
    }

    /**
     * @notice Returns and deploys (if not already) the interchain account for a given `origin`/`sender` pair.
     * @param _origin The origin domain of the interchain account.
     * @param _sender The parent account address on the origin domain.
     * @return The address of the interchain account.
     */
    function getDeployedInterchainAccount(uint32 _origin, address _sender)
        public
        returns (OwnableMulticall)
    {
        bytes32 salt = _salt(_origin, _sender);
        address payable interchainAccount = _getInterchainAccount(salt);
        if (!Address.isContract(interchainAccount)) {
            bytes memory bytecode = MinimalProxy.bytecode(implementation);
            interchainAccount = payable(Create2.deploy(0, salt, bytecode));
            // transfers ownership to this contract
            OwnableMulticall(interchainAccount).initialize();
            emit InterchainAccountCreated(_origin, _sender, interchainAccount);
        }
        return OwnableMulticall(interchainAccount);
    }

    /**
     * @notice Returns the salt used to deploy the interchain account for a given `origin`/`sender` pair.
     * @param _origin The origin domain of the interchain account.
     * @param _sender The parent account address on the origin domain.
     * @return The CREATE2 salt used for deploying the interchain account.
     */
    function _salt(uint32 _origin, address _sender)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(abi.encodePacked(_origin, _sender));
    }

    /**
     * @notice Returns the address of the interchain account deployed on the current chain for a given salt.
     * @param salt The salt used to deploy the interchain account.
     * @return The address of the interchain account.
     */
    function _getInterchainAccount(bytes32 salt)
        internal
        view
        returns (address payable)
    {
        return payable(Create2.computeAddress(salt, bytecodeHash));
    }

    /**
     * @notice Handles dispatched messages by relaying calls to the interchain account.
     * @param _origin The origin domain of the interchain account.
     * @param _message The ABI-encoded message containing the sender and the sequence of calls to be relayed.
     */
    function _handle(
        uint32 _origin,
        bytes32, // router sender
        bytes calldata _message
    ) internal override {
        InterchainCallMessage.Type calltype = _message.calltype();
        OwnableMulticall interchainAccount = getDeployedInterchainAccount(
            _origin,
            _message.sender()
        );
        if (calltype == InterchainCallMessage.Type.DEFAULT) {
            interchainAccount.proxyCalls(_message.defaultCalls());
        } else if (calltype == InterchainCallMessage.Type.WITH_VALUE) {
            interchainAccount.proxyCallsWithValue(_message.callsWithValue());
        } else {
            assert(false);
        }
    }
}
