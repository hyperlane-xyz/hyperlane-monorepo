// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {OwnableMulticall} from "./libs/OwnableMulticall.sol";
import {InterchainAccountMessage} from "./libs/InterchainAccountMessage.sol";
import {CallLib} from "./libs/Call.sol";
import {MinimalProxy} from "../libs/MinimalProxy.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Router} from "../client/Router.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {CommitmentReadIsm} from "../isms/ccip-read/CommitmentReadIsm.sol";
import {Mailbox} from "../Mailbox.sol";
import {Message} from "../libs/Message.sol";
import {AbstractRoutingIsm} from "../isms/routing/AbstractRoutingIsm.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/*
 * @title A contract that allows accounts on chain A to call contracts via a
 * proxy contract on chain B.
 */
contract InterchainAccountRouter is Router, AbstractRoutingIsm {
    // ============ Libraries ============

    using TypeCasts for address;
    using TypeCasts for bytes32;
    using InterchainAccountMessage for bytes;
    using Message for bytes;
    using StandardHookMetadata for bytes;

    // ============ Constants ============

    address public immutable implementation;
    bytes32 public immutable bytecodeHash;
    CommitmentReadIsm public immutable CCIP_READ_ISM;
    uint public constant COMMIT_TX_GAS_USAGE = 10_000;

    // ============ Public Storage ============
    mapping(uint32 => bytes32) public isms;
    /// @notice A mapping of commitments to the ICA that should execute the revealed calldata
    /// @dev The commitment is only stored if a `COMMITMENT` message was processed for it
    mapping(bytes32 commitment => OwnableMulticall ICA)
        public verifiedCommitments;

    // ============ Upgrade Gap ============

    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a default ISM is set for a remote domain
     * @param domain The remote domain
     * @param ism The address of the remote ISM
     */
    event RemoteIsmEnrolled(uint32 indexed domain, bytes32 ism);

    /**
     * @notice Emitted when an interchain call is dispatched to a remote domain
     * @param destination The destination domain on which to make the call
     * @param owner The local owner of the remote ICA
     * @param router The address of the remote router
     * @param ism The address of the remote ISM
     */
    event RemoteCallDispatched(
        uint32 indexed destination,
        address indexed owner,
        bytes32 router,
        bytes32 ism
    );

    /**
     * @notice Emitted when an interchain account contract is deployed
     * @param account The address of the proxy account that was created
     * @param origin The domain of the chain where the message was sent from
     * @param router The router on the origin domain
     * @param owner The address of the account that sent the message
     * @param ism The address of the local ISM
     * @param salt The salt used to derive the interchain account
     */
    event InterchainAccountCreated(
        address indexed account,
        uint32 origin,
        bytes32 router,
        bytes32 owner,
        address ism,
        bytes32 salt
    );

    // ============ Constructor ============
    constructor(
        address _mailbox,
        address _hook,
        address _owner
    ) Router(_mailbox) {
        setHook(_hook);
        _transferOwnership(_owner);

        bytes memory bytecode = _implementationBytecode(address(this));
        implementation = Create2.deploy(0, bytes32(0), bytecode);
        bytecodeHash = _proxyBytecodeHash(implementation);

        CCIP_READ_ISM = new CommitmentReadIsm(Mailbox(_mailbox));
        interchainSecurityModule = IInterchainSecurityModule(address(this));
    }

    /**
     * @notice Registers the address of remote InterchainAccountRouter
     * and ISM contracts to use as a default when making interchain calls
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _ism The address of the remote ISM
     */
    function enrollRemoteRouterAndIsm(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism
    ) external onlyOwner {
        _enrollRemoteRouterAndIsm(_destination, _router, _ism);
    }

    /**
     * @notice Registers the address of remote InterchainAccountRouters
     * and ISM contracts to use as defaults when making interchain calls
     * @param _destinations The remote domains
     * @param _routers The address of the remote InterchainAccountRouters
     * @param _isms The address of the remote ISMs
     */
    function enrollRemoteRouterAndIsms(
        uint32[] calldata _destinations,
        bytes32[] calldata _routers,
        bytes32[] calldata _isms
    ) external onlyOwner {
        require(
            _destinations.length == _routers.length &&
                _destinations.length == _isms.length,
            "length mismatch"
        );
        for (uint256 i = 0; i < _destinations.length; i++) {
            _enrollRemoteRouterAndIsm(_destinations[i], _routers[i], _isms[i]);
        }
    }

    // ============ External Functions ============
    /**
     * @notice Dispatches a single remote call to be made by an owner's
     * interchain account on the destination domain
     * @dev Uses the default router and ISM addresses for the destination
     * domain, reverting if none have been configured
     * @param _destination The remote domain of the chain to make calls on
     * @param _to The address of the contract to call
     * @param _value The value to include in the call
     * @param _data The calldata
     * @return The Hyperlane message ID
     */
    function callRemote(
        uint32 _destination,
        address _to,
        uint256 _value,
        bytes memory _data
    ) external payable returns (bytes32) {
        bytes32 _router = routers(_destination);
        bytes32 _ism = isms[_destination];
        bytes memory _body = InterchainAccountMessage.encode(
            msg.sender,
            _ism,
            _to,
            _value,
            _data
        );
        return _dispatchMessage(_destination, _router, _ism, _body);
    }

    /**
     * @notice Dispatches a single remote call to be made by an owner's
     * interchain account on the destination domain
     * @dev Uses the default router and ISM addresses for the destination
     * domain, reverting if none have been configured
     * @param _destination The remote domain of the chain to make calls on
     * @param _to The address of the contract to call
     * @param _value The value to include in the call
     * @param _data The calldata
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     * @return The Hyperlane message ID
     */
    function callRemote(
        uint32 _destination,
        address _to,
        uint256 _value,
        bytes memory _data,
        bytes memory _hookMetadata
    ) external payable returns (bytes32) {
        bytes32 _router = routers(_destination);
        bytes32 _ism = isms[_destination];
        bytes memory _body = InterchainAccountMessage.encode(
            msg.sender,
            _ism,
            _to,
            _value,
            _data
        );
        return
            _dispatchMessageWithMetadata(
                _destination,
                _router,
                _ism,
                _body,
                _hookMetadata
            );
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by an owner's
     * interchain account on the destination domain
     * @dev Uses the default router and ISM addresses for the destination
     * domain, reverting if none have been configured
     * @dev Recommend using CallLib.build to format the interchain calls.
     * @param _destination The remote domain of the chain to make calls on
     * @param _calls The sequence of calls to make
     * @return The Hyperlane message ID
     */
    function callRemote(
        uint32 _destination,
        CallLib.Call[] calldata _calls
    ) external payable returns (bytes32) {
        bytes32 _router = routers(_destination);
        bytes32 _ism = isms[_destination];
        bytes memory _body = InterchainAccountMessage.encode(
            msg.sender,
            _ism,
            _calls
        );

        return _dispatchMessage(_destination, _router, _ism, _body);
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by an owner's
     * interchain account on the destination domain
     * @dev Uses the default router and ISM addresses for the destination
     * domain, reverting if none have been configured
     * @dev Recommend using CallLib.build to format the interchain calls.
     * @param _destination The remote domain of the chain to make calls on
     * @param _calls The sequence of calls to make
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     * @return The Hyperlane message ID
     */
    function callRemote(
        uint32 _destination,
        CallLib.Call[] calldata _calls,
        bytes calldata _hookMetadata
    ) external payable returns (bytes32) {
        bytes32 _router = routers(_destination);
        bytes32 _ism = isms[_destination];
        return
            callRemoteWithOverrides(
                _destination,
                _router,
                _ism,
                _calls,
                _hookMetadata
            );
    }

    /**
     * @notice Handles dispatched messages by relaying calls to the interchain account
     * @param _origin The origin domain of the interchain account
     * @param _sender The sender of the interchain message
     * @param _message The InterchainAccountMessage containing the account
     * owner, ISM, and sequence of calls to be relayed
     * @dev Does not need to be onlyRemoteRouter, as this application is designed
     * to receive messages from untrusted remote contracts.
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable override onlyMailbox {
        InterchainAccountMessage.MessageType _messageType = _message
            .messageType();

        // If the message is a reveal, we don't do any derivation of the ica address
        // The commitment should be executed in the `verify` method of the CCIP read ISM that verified this message
        // so here we just check that commitment -> ICA association has been cleared
        if (_messageType == InterchainAccountMessage.MessageType.REVEAL) {
            // The commitment should be executed in the `verify` method of the CCIP read ISM that verified this message
            require(
                verifiedCommitments[_message.commitment(_messageType)] ==
                    OwnableMulticall(payable(address(0))),
                "Commitment was not executed"
            );
            return;
        }

        bytes32 _owner = _message.owner();
        bytes32 _ism = _message.ism(_messageType);
        bytes32 _salt = _message.salt();

        OwnableMulticall ica = getDeployedInterchainAccount(
            _origin,
            _owner,
            _sender,
            _ism.bytes32ToAddress(),
            _salt
        );

        if (_messageType == InterchainAccountMessage.MessageType.CALLS) {
            CallLib.Call[] memory calls = _message.calls();
            ica.multicall{value: msg.value}(calls);
        } else {
            bytes32 commitment = _message.commitment(_messageType);
            verifiedCommitments[commitment] = ica;
        }
    }

    function route(
        bytes calldata _message
    ) public view override returns (IInterchainSecurityModule) {
        bytes calldata _body = _message.body();
        IInterchainSecurityModule _ism = IInterchainSecurityModule(
            _body.ism(_body.messageType()).bytes32ToAddress()
        );

        // If the ISM is not set, we need to check if the message is a reveal
        // If it is, we need to set the ISM to the CCIP read ISM
        // Otherwise, we need to set the ISM to the default ISM
        if (address(_ism) == address(0)) {
            if (
                _body.messageType() ==
                InterchainAccountMessage.MessageType.REVEAL
            ) {
                _ism = CCIP_READ_ISM;
            } else {
                _ism = mailbox.defaultIsm();
            }
        }
        return _ism;
    }

    /**
     * @notice Returns the local address of an interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @param _origin The remote origin domain of the interchain account
     * @param _router The remote origin InterchainAccountRouter
     * @param _owner The remote owner of the interchain account
     * @param _ism The local address of the ISM
     * @return The local address of the interchain account
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        address _owner,
        address _router,
        address _ism
    ) external view returns (OwnableMulticall) {
        return
            getLocalInterchainAccount(
                _origin,
                _owner.addressToBytes32(),
                _router.addressToBytes32(),
                _ism
            );
    }

    /**
     * @notice Returns the remote address of a locally owned interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @dev This function will only work if the destination domain is
     * EVM compatible
     * @param _destination The remote destination domain of the interchain account
     * @param _owner The local owner of the interchain account
     * @return The remote address of the interchain account
     */
    function getRemoteInterchainAccount(
        uint32 _destination,
        address _owner
    ) external view returns (address) {
        return
            getRemoteInterchainAccount(
                _destination,
                _owner,
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    /**
     * @notice Returns the remote address of a locally owned interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @dev This function will only work if the destination domain is
     * EVM compatible
     * @param _destination The remote destination domain of the interchain account
     * @param _owner The local owner of the interchain account
     * @param _userSalt A user provided salt. Allows control over account derivation.
     * @return The remote address of the interchain account
     */
    function getRemoteInterchainAccount(
        uint32 _destination,
        address _owner,
        bytes32 _userSalt
    ) public view returns (address) {
        address _router = routers(_destination).bytes32ToAddress();
        address _ism = isms[_destination].bytes32ToAddress();
        return getRemoteInterchainAccount(_owner, _router, _ism, _userSalt);
    }

    // ============ Public Functions ============

    /**
     * @notice Returns and deploys (if not already) an interchain account
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _router The remote origin InterchainAccountRouter
     * @param _ism The local address of the ISM
     * @return The address of the interchain account
     */
    function getDeployedInterchainAccount(
        uint32 _origin,
        address _owner,
        address _router,
        address _ism
    ) public returns (OwnableMulticall) {
        return
            getDeployedInterchainAccount(
                _origin,
                _owner.addressToBytes32(),
                _router.addressToBytes32(),
                _ism,
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    /*
     * @notice Returns and deploys (if not already) an interchain account
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _router The remote origin InterchainAccountRouter
     * @param _ism The local address of the ISM
     * @return The address of the interchain account
     */
    function getDeployedInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        address _ism
    ) public returns (OwnableMulticall) {
        return
            getDeployedInterchainAccount(
                _origin,
                _owner,
                _router,
                _ism,
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    /**
     * @notice Returns and deploys (if not already) an interchain account
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _router The remote origin InterchainAccountRouter
     * @param _ism The local address of the ISM
     * @return The address of the interchain account
     */
    function getDeployedInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        address _ism,
        bytes32 _userSalt
    ) public returns (OwnableMulticall) {
        bytes32 _deploySalt = _getSalt(
            _origin,
            _owner,
            _router,
            _ism.addressToBytes32(),
            _userSalt
        );
        address payable _account = _getLocalInterchainAccount(_deploySalt);
        if (!Address.isContract(_account)) {
            bytes memory _bytecode = MinimalProxy.bytecode(implementation);
            _account = payable(Create2.deploy(0, _deploySalt, _bytecode));
            emit InterchainAccountCreated(
                _account,
                _origin,
                _router,
                _owner,
                _ism,
                _userSalt
            );
        }
        return OwnableMulticall(_account);
    }

    /**
     * @notice Returns the local address of a remotely owned interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _router The remote InterchainAccountRouter
     * @param _ism The local address of the ISM
     * @return The local address of the interchain account
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        address _ism
    ) public view returns (OwnableMulticall) {
        return
            getLocalInterchainAccount(
                _origin,
                _owner,
                _router,
                _ism,
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    /**
     * @notice Returns the local address of a remotely owned interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _router The remote InterchainAccountRouter
     * @param _ism The local address of the ISM
     * @param _userSalt A user provided salt. Allows control over account derivation.
     * @return The local address of the interchain account
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        address _ism,
        bytes32 _userSalt
    ) public view returns (OwnableMulticall) {
        return
            OwnableMulticall(
                _getLocalInterchainAccount(
                    _getSalt(
                        _origin,
                        _owner,
                        _router,
                        _ism.addressToBytes32(),
                        _userSalt
                    )
                )
            );
    }

    /**
     * @notice Returns the remote address of a locally owned interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @dev This function will only work if the destination domain is
     * EVM compatible
     * @param _owner The local owner of the interchain account
     * @param _router The remote InterchainAccountRouter
     * @param _ism The remote address of the ISM
     * @return The remote address of the interchain account
     */
    function getRemoteInterchainAccount(
        address _owner,
        address _router,
        address _ism
    ) public view returns (address) {
        return
            getRemoteInterchainAccount(
                _owner,
                _router,
                _ism,
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    /**
     * @notice Returns the remote address of a locally owned interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @dev This function will only work if the destination domain is
     * EVM compatible
     * @param _owner The local owner of the interchain account
     * @param _router The remote InterchainAccountRouter
     * @param _ism The remote address of the ISM
     * @param _userSalt Salt provided by the user, allows control over account derivation.
     * @return The remote address of the interchain account
     */
    function getRemoteInterchainAccount(
        address _owner,
        address _router,
        address _ism,
        bytes32 _userSalt
    ) public view returns (address) {
        require(_router != address(0), "no router specified for destination");

        // replicate router constructor Create2 derivation
        address _implementation = Create2.computeAddress(
            bytes32(0),
            keccak256(_implementationBytecode(_router)),
            _router
        );

        bytes32 _bytecodeHash = _proxyBytecodeHash(_implementation);
        bytes32 _salt = _getSalt(
            localDomain,
            _owner.addressToBytes32(),
            address(this).addressToBytes32(),
            _ism.addressToBytes32(),
            _userSalt
        );
        return Create2.computeAddress(_salt, _bytecodeHash, _router);
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by an owner's
     * interchain account on the destination domain
     * @dev Recommend using CallLib.build to format the interchain calls
     * @param _destination The remote domain of the chain to make calls on
     * @param _router The remote router address
     * @param _ism The remote ISM address
     * @param _calls The sequence of calls to make
     * @return The Hyperlane message ID
     */
    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata _calls
    ) public payable returns (bytes32) {
        return
            callRemoteWithOverrides(
                _destination,
                _router,
                _ism,
                _calls,
                bytes(""),
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by an owner's
     * interchain account on the destination domain
     * @dev Recommend using CallLib.build to format the interchain calls
     * @param _destination The remote domain of the chain to make calls on
     * @param _router The remote router address
     * @param _ism The remote ISM address
     * @param _calls The sequence of calls to make
     * @return The Hyperlane message ID
     */
    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata _calls,
        bytes32 _userSalt
    ) public payable returns (bytes32) {
        return
            callRemoteWithOverrides(
                _destination,
                _router,
                _ism,
                _calls,
                bytes(""),
                _userSalt
            );
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by an owner's
     * interchain account on the destination domain
     * @dev Recommend using CallLib.build to format the interchain calls
     * @param _destination The remote domain of the chain to make calls on
     * @param _router The remote router address
     * @param _ism The remote ISM address
     * @param _calls The sequence of calls to make
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     * @return The Hyperlane message ID
     */
    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata _calls,
        bytes memory _hookMetadata
    ) public payable returns (bytes32) {
        return
            callRemoteWithOverrides(
                _destination,
                _router,
                _ism,
                _calls,
                _hookMetadata,
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by an owner's
     * interchain account on the destination domain
     * @dev Recommend using CallLib.build to format the interchain calls
     * @param _destination The remote domain of the chain to make calls on
     * @param _router The remote router address
     * @param _ism The remote ISM address
     * @param _calls The sequence of calls to make
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     * @param _userSalt Salt provided by the user, allows control over account derivation.
     * @return The Hyperlane message ID
     */
    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata _calls,
        bytes memory _hookMetadata,
        bytes32 _userSalt
    ) public payable returns (bytes32) {
        return
            callRemoteWithOverrides(
                _destination,
                _router,
                _ism,
                _calls,
                _hookMetadata,
                _userSalt,
                hook
            );
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by an owner's
     * interchain account on the destination domain
     * @dev Recommend using CallLib.build to format the interchain calls
     * @param _destination The remote domain of the chain to make calls on
     * @param _router The remote router address
     * @param _ism The remote ISM address
     * @param _calls The sequence of calls to make
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     * @param _salt Salt which allows control over account derivation.
     * @param _hook The hook to use after sending our message to the mailbox
     * @return The Hyperlane message ID
     */
    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata _calls,
        bytes memory _hookMetadata,
        bytes32 _salt,
        IPostDispatchHook _hook
    ) public payable returns (bytes32) {
        bytes memory _body = InterchainAccountMessage.encode(
            msg.sender,
            _ism,
            _calls,
            _salt
        );
        return
            _dispatchMessageWithHook(
                _destination,
                _router,
                _ism,
                _body,
                _hookMetadata,
                _hook
            );
    }

    /**
     * @notice Dispatches a commitment and reveal message to the destination domain.
     *  Useful for when we want to keep calldata secret (e.g. when executing a swap
     * @dev The commitment message is dispatched first, followed by the reveal message.
     * To find the calladata, the user must fetch the calldata from the url provided by the OffChainLookupIsm
     * specified in the _ccipReadIsm parameter.
     * The revealed calladata is executed by the `revealAndExecute` function, which will be called the OffChainLookupIsm in its `verify` function.
     * @param _destination The remote domain of the chain to make calls on
     * @param _router The remote router address
     * @param _ism The remote ISM address
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     * @param _salt Salt which allows control over account derivation.
     * @param _hook The hook to use after sending our message to the mailbox
     * @param _commitment The commitment to dispatch
     * @return _commitmentMsgId The Hyperlane message ID of the commitment message
     * @return _revealMsgId The Hyperlane message ID of the reveal message
     */
    function callRemoteCommitReveal(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes32 _ccipReadIsm,
        bytes memory _hookMetadata,
        IPostDispatchHook _hook,
        bytes32 _salt,
        bytes32 _commitment
    ) public payable returns (bytes32 _commitmentMsgId, bytes32 _revealMsgId) {
        bytes memory _commitmentMsg = InterchainAccountMessage
            .encodeCommitment({
                _owner: msg.sender.addressToBytes32(),
                _ism: _ism,
                _commitment: _commitment,
                _userSalt: _salt
            });
        bytes memory _revealMsg = InterchainAccountMessage.encodeReveal({
            _ism: _ccipReadIsm,
            _commitment: _commitment
        });

        uint commitMsgValue = (msg.value * COMMIT_TX_GAS_USAGE) /
            (_hookMetadata.gasLimit() + COMMIT_TX_GAS_USAGE);

        _commitmentMsgId = _dispatchMessageWithValue(
            _destination,
            _router,
            _ism,
            _commitmentMsg,
            StandardHookMetadata.overrideGasLimit(COMMIT_TX_GAS_USAGE),
            _hook,
            commitMsgValue
        );
        _revealMsgId = _dispatchMessageWithValue(
            _destination,
            _router,
            _ism,
            _revealMsg,
            _hookMetadata,
            _hook,
            msg.value - commitMsgValue
        );
    }

    function callRemoteCommitReveal(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes memory _hookMetadata,
        IPostDispatchHook _hook,
        bytes32 _salt,
        bytes32 _commitment
    ) public payable returns (bytes32 _commitmentMsgId, bytes32 _revealMsgId) {
        return
            callRemoteCommitReveal(
                _destination,
                _router,
                _ism,
                bytes32(0),
                _hookMetadata,
                _hook,
                _salt,
                _commitment
            );
    }

    function callRemoteCommitReveal(
        uint32 _destination,
        bytes32 _commitment,
        uint _gasLimit
    ) public payable returns (bytes32 _commitmentMsgId, bytes32 _revealMsgId) {
        bytes32 _router = routers(_destination);
        bytes32 _ism = isms[_destination];

        bytes memory hookMetadata = StandardHookMetadata.overrideGasLimit(
            _gasLimit
        );

        return
            callRemoteCommitReveal(
                _destination,
                _router,
                _ism,
                bytes32(0),
                hookMetadata,
                hook,
                InterchainAccountMessage.EMPTY_SALT,
                _commitment
            );
    }

    /// @dev The calls represented by the commitment can only be executed once per commitment,
    /// though you can submit the same commitment again after the calls have been executed.
    function revealAndExecute(
        CallLib.Call[] calldata _calls,
        bytes32 _salt
    ) external payable {
        bytes32 _givenCommitment = keccak256(abi.encode(_salt, _calls));
        OwnableMulticall ica = verifiedCommitments[_givenCommitment];
        require(address(payable(ica)) != address(0), "Invalid Reveal");

        delete verifiedCommitments[_givenCommitment];
        ica.multicall{value: msg.value}(_calls);
    }

    // ============ Internal Functions ============
    function _implementationBytecode(
        address router
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                type(OwnableMulticall).creationCode,
                abi.encode(router)
            );
    }

    function _proxyBytecodeHash(
        address _implementation
    ) internal pure returns (bytes32) {
        return keccak256(MinimalProxy.bytecode(_implementation));
    }

    /**
     * @dev Required for use of Router, compiler will not include this function in the bytecode
     */
    function _handle(uint32, bytes32, bytes calldata) internal pure override {
        assert(false);
    }

    /**
     * @notice Overrides Router._enrollRemoteRouter to also enroll a default ISM
     * @param _destination The remote domain
     * @param _address The address of the remote InterchainAccountRouter
     * @dev Sets the default ISM to the zero address
     */
    function _enrollRemoteRouter(
        uint32 _destination,
        bytes32 _address
    ) internal override {
        _enrollRemoteRouterAndIsm(
            _destination,
            _address,
            InterchainAccountMessage.EMPTY_SALT
        );
    }

    // ============ Private Functions ============

    /**
     * @notice Registers the address of a remote ISM contract to use as default
     * @param _destination The remote domain
     * @param _ism The address of the remote ISM
     */
    function _enrollRemoteIsm(uint32 _destination, bytes32 _ism) private {
        isms[_destination] = _ism;
        emit RemoteIsmEnrolled(_destination, _ism);
    }

    /**
     * @notice Registers the address of remote InterchainAccountRouter
     * and ISM contracts to use as a default when making interchain calls
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _ism The address of the remote ISM
     */
    function _enrollRemoteRouterAndIsm(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism
    ) private {
        require(
            routers(_destination) == InterchainAccountMessage.EMPTY_SALT &&
                isms[_destination] == InterchainAccountMessage.EMPTY_SALT,
            "router and ISM defaults are immutable once set"
        );
        Router._enrollRemoteRouter(_destination, _router);
        _enrollRemoteIsm(_destination, _ism);
    }

    /**
     * @notice Dispatches an InterchainAccountMessage to the remote router
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _ism The address of the remote ISM
     * @param _body The InterchainAccountMessage body
     */
    function _dispatchMessage(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes memory _body
    ) private returns (bytes32) {
        return
            _dispatchMessageWithMetadata(
                _destination,
                _router,
                _ism,
                _body,
                bytes("")
            );
    }

    /**
     * @notice Dispatches an InterchainAccountMessage to the remote router with hook metadata
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _ism The address of the remote ISM
     * @param _body The InterchainAccountMessage body
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     */
    function _dispatchMessageWithMetadata(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes memory _body,
        bytes memory _hookMetadata
    ) private returns (bytes32) {
        return
            _dispatchMessageWithHook(
                _destination,
                _router,
                _ism,
                _body,
                _hookMetadata,
                hook
            );
    }

    /**
     * @notice Dispatches an InterchainAccountMessage to the remote router with hook metadata
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _ism The address of the remote ISM
     * @param _body The InterchainAccountMessage body
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     * @param _hook The hook to use after sending our message to the mailbox
     */
    function _dispatchMessageWithHook(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes memory _body,
        bytes memory _hookMetadata,
        IPostDispatchHook _hook
    ) private returns (bytes32) {
        return
            _dispatchMessageWithValue(
                _destination,
                _router,
                _ism,
                _body,
                _hookMetadata,
                _hook,
                msg.value
            );
    }

    /**
     * @notice Dispatches an InterchainAccountMessage to the remote router using a `value` parameter for msg.value
     * @param _value The amount to pass as `msg.value` to the mailbox.dispatch()
     */
    function _dispatchMessageWithValue(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes memory _body,
        bytes memory _hookMetadata,
        IPostDispatchHook _hook,
        uint _value
    ) private returns (bytes32) {
        require(
            _router != InterchainAccountMessage.EMPTY_SALT,
            "no router specified for destination"
        );
        emit RemoteCallDispatched(_destination, msg.sender, _router, _ism);
        return
            mailbox.dispatch{value: _value}(
                _destination,
                _router,
                _body,
                _hookMetadata,
                _hook
            );
    }

    /**
     * @notice Returns the salt used to deploy an interchain account
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _router The remote origin InterchainAccountRouter
     * @param _ism The local address of the ISM
     * @param _userSalt Salt provided by the user, allows control over account derivation.
     * @return The CREATE2 salt used for deploying the interchain account
     */
    function _getSalt(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        bytes32 _ism,
        bytes32 _userSalt
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(_origin, _owner, _router, _ism, _userSalt)
            );
    }

    /**
     * @notice Returns the address of the interchain account on the local chain
     * @param _salt The CREATE2 salt used for deploying the interchain account
     * @return The address of the interchain account
     */
    function _getLocalInterchainAccount(
        bytes32 _salt
    ) private view returns (address payable) {
        return payable(Create2.computeAddress(_salt, bytecodeHash));
    }

    /**
     * @notice Returns the gas payment required to dispatch a message to the given domain's router.
     * @param _destination The domain of the destination router.
     * @return _gasPayment Payment computed by the registered hooks via MailboxClient.
     */
    function quoteGasPayment(
        uint32 _destination
    ) external view returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                new bytes(0),
                new bytes(0),
                address(hook)
            );
    }

    /**
     * @notice Returns the gas payment required to dispatch a given messageBody to the given domain's router with gas limit override.
     * @param _destination The domain of the destination router.
     * @param _messageBody The message body to be dispatched.
     * @param gasLimit The gas limit to override with.
     */
    function quoteGasPayment(
        uint32 _destination,
        bytes calldata _messageBody,
        uint256 gasLimit
    ) external view returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                _messageBody,
                StandardHookMetadata.overrideGasLimit(gasLimit),
                address(hook)
            );
    }
}
