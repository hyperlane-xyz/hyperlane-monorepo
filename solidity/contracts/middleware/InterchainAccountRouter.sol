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
import {InterchainAccountMessage, InterchainAccountMessageReveal} from "./libs/InterchainAccountMessage.sol";
import {CallLib} from "./libs/Call.sol";
import {AbstractInterchainAccountRouter} from "./AbstractInterchainAccountRouter.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Router} from "../client/Router.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {CommitmentReadIsm} from "../isms/ccip-read/CommitmentReadIsm.sol";
import {Message} from "../libs/Message.sol";
import {AbstractRoutingIsm} from "../isms/routing/AbstractRoutingIsm.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/*
 * @title A contract that allows accounts on chain A to call contracts via a
 * proxy contract on chain B.
 * @dev ISMs enrolled alongside routers via _enrollRemoteRouterAndIsm, domains always match router table
 */
contract InterchainAccountRouter is
    AbstractInterchainAccountRouter,
    AbstractRoutingIsm
{
    // ============ Libraries ============

    using TypeCasts for address;
    using TypeCasts for bytes32;
    using InterchainAccountMessage for bytes;
    using Message for bytes;
    using StandardHookMetadata for bytes;

    // ============ Constants ============

    CommitmentReadIsm public immutable CCIP_READ_ISM;
    uint public immutable COMMIT_TX_GAS_USAGE;

    /**
     * @notice Emitted when a commit-reveal interchain call is dispatched to a remote domain
     * @param commitment The commitment that was dispatched
     */
    event CommitRevealDispatched(bytes32 indexed commitment);

    // ============ Constructor ============
    constructor(
        address _mailbox,
        address _hook,
        address _owner,
        uint _commit_tx_gas_usage,
        string[] memory _commitment_urls
    ) Router(_mailbox) {
        setHook(_hook);
        _transferOwnership(_owner);

        bytes memory bytecode = _implementationBytecode(address(this));
        implementation = Create2.deploy(0, bytes32(0), bytecode);
        bytecodeHash = _proxyBytecodeHash(implementation);

        CCIP_READ_ISM = new CommitmentReadIsm(_owner, _commitment_urls);
        COMMIT_TX_GAS_USAGE = _commit_tx_gas_usage;
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
    ) public payable returns (bytes32) {
        return callRemote(_destination, _calls, bytes(""));
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
        bytes memory _hookMetadata
    ) public payable returns (bytes32) {
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
        if (_messageType == InterchainAccountMessage.MessageType.REVEAL) {
            // If the message is a reveal,
            // the commitment should have been executed in the `verify` method of the ISM
            // that verified this message. The commitment is deleted in `revealAndExecute`.
            // Simply return.
            return;
        }

        bytes32 _owner = _message.owner();
        bytes32 _salt = _message.salt();
        bytes32 _ism = _message.ism();

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
            // This is definitely a message of type COMMITMENT
            ica.setCommitment(_message.commitment());
        }
    }

    function route(
        bytes calldata _message
    ) public view override returns (IInterchainSecurityModule) {
        bytes calldata _body = _message.body();
        InterchainAccountMessage.MessageType _messageType = _body.messageType();

        // If the ISM is not set, we need to check if the message is a reveal
        // If it is, we need to set the ISM to the CCIP read ISM
        // Otherwise, we need to set the ISM to the default ISM
        address _ism;
        if (_messageType == InterchainAccountMessage.MessageType.REVEAL) {
            _ism = InterchainAccountMessageReveal
                .revealIsm(_body)
                .bytes32ToAddress();
            _ism = _ism == address(0) ? address(CCIP_READ_ISM) : _ism;
        } else {
            _ism = InterchainAccountMessage.ism(_body).bytes32ToAddress();
            _ism = _ism == address(0) ? address(mailbox.defaultIsm()) : _ism;
        }

        return IInterchainSecurityModule(_ism);
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
    ) external view override returns (OwnableMulticall) {
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
     * @dev Convenience overload with default empty salt. Delegates to
     * AbstractInterchainAccountRouter.getRemoteInterchainAccount(address,address,address,bytes32).
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
    ) public payable override returns (bytes32) {
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
        emit RemoteCallDispatched(
            _destination,
            msg.sender,
            _router,
            _ism,
            _salt
        );
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

        emit RemoteCallDispatched(
            _destination,
            msg.sender,
            _router,
            _ism,
            _salt
        );
        emit CommitRevealDispatched(_commitment);

        _commitmentMsgId = _dispatchMessageWithValue(
            _destination,
            _router,
            _commitmentMsg,
            StandardHookMetadata.formatWithFeeToken(
                0,
                COMMIT_TX_GAS_USAGE,
                address(this),
                _hookMetadata.feeToken()
            ),
            _hook,
            msg.value
        );

        bytes memory _revealMsg = InterchainAccountMessage.encodeReveal({
            _ism: _ccipReadIsm,
            _commitment: _commitment
        });
        _revealMsgId = _dispatchMessageWithValue(
            _destination,
            _router,
            _revealMsg,
            _hookMetadata,
            _hook,
            address(this).balance
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

        bytes memory hookMetadata = StandardHookMetadata.formatMetadata(
            0,
            _gasLimit,
            msg.sender,
            bytes("")
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

    /**
     * @notice Dispatches an InterchainAccountMessage to the remote router
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _body The InterchainAccountMessage body
     */
    function _dispatchMessage(
        uint32 _destination,
        bytes32 _router,
        bytes memory _body
    ) private returns (bytes32) {
        return
            _dispatchMessageWithMetadata(
                _destination,
                _router,
                _body,
                bytes("")
            );
    }

    /**
     * @notice Dispatches an InterchainAccountMessage to the remote router with hook metadata
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _body The InterchainAccountMessage body
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     */
    function _dispatchMessageWithMetadata(
        uint32 _destination,
        bytes32 _router,
        bytes memory _body,
        bytes memory _hookMetadata
    ) private returns (bytes32) {
        return
            _dispatchMessageWithHook(
                _destination,
                _router,
                _body,
                _hookMetadata,
                hook
            );
    }

    /**
     * @notice Dispatches an InterchainAccountMessage to the remote router with hook metadata
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _body The InterchainAccountMessage body
     * @param _hookMetadata The hook metadata to override with for the hook set by the owner
     * @param _hook The hook to use after sending our message to the mailbox
     */
    function _dispatchMessageWithHook(
        uint32 _destination,
        bytes32 _router,
        bytes memory _body,
        bytes memory _hookMetadata,
        IPostDispatchHook _hook
    ) private returns (bytes32) {
        return
            _dispatchMessageWithValue(
                _destination,
                _router,
                _body,
                _hookMetadata,
                _hook,
                msg.value
            );
    }

    /**
     * @notice Returns the gas payment required to dispatch a message to the given domain's router.
     * @param _destination The domain of the destination router.
     * @return _gasPayment Payment computed by the registered hooks via MailboxClient.
     */
    function quoteGasPayment(
        uint32 _destination
    ) public view returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                bytes(""),
                bytes(""),
                address(hook)
            );
    }

    /**
     * @notice Returns the ERC20 token payment required to dispatch a message.
     * @param _feeToken The ERC20 token to pay gas fees in.
     * @param _destination The domain of the destination router.
     * @param _gasLimit The gas limit that the calls will use.
     * @return _gasPayment Payment amount in the specified token.
     */
    function quoteGasPayment(
        address _feeToken,
        uint32 _destination,
        uint256 _gasLimit
    ) public view returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                new bytes(0),
                StandardHookMetadata.formatWithFeeToken(
                    0,
                    _gasLimit,
                    msg.sender,
                    _feeToken
                ),
                address(hook)
            );
    }

    /**
     * @notice Returns the native payment required to commit reveal to the destination router.
     * @param _destination The domain of the destination router.
     * @param gasLimit The gas limit that the reveal calls will use.
     * @return _gasPayment Payment computed by the registered hooks via MailboxClient.
     */
    function quoteGasForCommitReveal(
        uint32 _destination,
        uint256 gasLimit
    ) external view returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                new bytes(0),
                StandardHookMetadata.overrideGasLimit(COMMIT_TX_GAS_USAGE),
                address(hook)
            ) + quoteGasPayment(_destination, gasLimit);
    }

    /**
     * @notice Returns the ERC20 token payment required to commit reveal to the destination router.
     * @param _feeToken The ERC20 token to pay gas fees in.
     * @param _destination The domain of the destination router.
     * @param gasLimit The gas limit that the reveal calls will use.
     * @return _gasPayment Payment amount in the specified token for both commit and reveal dispatches.
     */
    function quoteGasForCommitReveal(
        address _feeToken,
        uint32 _destination,
        uint256 gasLimit
    ) external view returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                new bytes(0),
                StandardHookMetadata.formatWithFeeToken(
                    0,
                    COMMIT_TX_GAS_USAGE,
                    msg.sender,
                    _feeToken
                ),
                address(hook)
            ) + quoteGasPayment(_feeToken, _destination, gasLimit);
    }
}
