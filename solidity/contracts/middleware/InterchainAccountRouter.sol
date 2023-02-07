// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {OwnableMulticall} from "../OwnableMulticall.sol";
import {Router} from "../Router.sol";
import {IInterchainAccountRouter} from "../../interfaces/IInterchainAccountRouter.sol";
import {InterchainCallMessage} from "./InterchainCallMessage.sol";
import {MinimalProxy} from "../libs/MinimalProxy.sol";
import {CallLib} from "../libs/Call.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/*
 * @title Interchain Accounts Router that relays messages via proxy contracts on other chains.
 * @dev Currently does not support Sovereign Consensus (user specified Interchain Security Modules).
 */
contract InterchainAccountRouter is Router, IInterchainAccountRouter {
    using InterchainCallMessage for bytes;

    using TypeCasts for address;
    using TypeCasts for bytes32;

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
        bytes32 sender,
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
        return
            _dispatch(
                _destinationDomain,
                InterchainCallMessage.format(
                    calls,
                    msg.sender.addressToBytes32()
                )
            );
    }

    /**
     * @notice Returns the address of the interchain account deployed on the current chain for a given `origin`/`sender` pair.
     * @param _origin The origin domain of the interchain account.
     * @param _sender The parent account address on the origin domain.
     * @return The address of the interchain account.
     */
    function getInterchainAccount(uint32 _origin, bytes32 _sender)
        public
        view
        returns (address payable)
    {
        return _getInterchainAccount(_salt(_origin, _sender));
    }

    function getInterchainAccount(uint32 _origin, address _sender)
        external
        view
        returns (address payable)
    {
        return getInterchainAccount(_origin, _sender.addressToBytes32());
    }

    /**
     * @notice Returns and deploys (if not already) the interchain account for a given `origin`/`sender` pair.
     * @param _origin The origin domain of the interchain account.
     * @param _sender The parent account address on the origin domain.
     * @return The address of the interchain account.
     */
    function getDeployedInterchainAccount(uint32 _origin, bytes32 _sender)
        public
        returns (OwnableMulticall)
    {
        bytes32 salt = _salt(_origin, _sender);
        address payable interchainAccount = _getInterchainAccount(salt);
        if (!Address.isContract(interchainAccount)) {
            bytes memory bytecode = MinimalProxy.bytecode(implementation);
            interchainAccount = payable(Create2.deploy(0, salt, bytecode));
            emit InterchainAccountCreated(_origin, _sender, interchainAccount);
            // transfers ownership to this contract
            OwnableMulticall(interchainAccount).initialize();
        }
        return OwnableMulticall(interchainAccount);
    }

    function getDeployedInterchainAccount(uint32 _origin, address _sender)
        public
        returns (OwnableMulticall)
    {
        return
            getDeployedInterchainAccount(_origin, _sender.addressToBytes32());
    }

    /**
     * @notice Returns the salt used to deploy the interchain account for a given `origin`/`sender` pair.
     * @param _origin The origin domain of the interchain account.
     * @param _sender The parent account address on the origin domain.
     * @return The CREATE2 salt used for deploying the interchain account.
     */
    function _salt(uint32 _origin, bytes32 _sender)
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
        OwnableMulticall interchainAccount = getDeployedInterchainAccount(
            _origin,
            _message.sender()
        );
        interchainAccount.proxyCalls(_message.calls());
    }
}
