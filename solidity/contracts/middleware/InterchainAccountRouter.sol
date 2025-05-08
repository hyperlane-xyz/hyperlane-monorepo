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
import {AccountConfig, MessageType, InterchainAccountMessage, InterchainAccountMessageCommitment, InterchainAccountMessageCalls, InterchainAccountMessageReveal} from "./libs/InterchainAccountMessage.sol";
import {CallLib} from "./libs/Call.sol";
import {MinimalProxy} from "../libs/MinimalProxy.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Router} from "../client/Router.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/*
 * @title A contract that allows accounts on chain A to call contracts via a
 * proxy contract on chain B.
 */
contract InterchainAccountRouter is Router {
    // ============ Libraries ============

    using TypeCasts for address;
    using TypeCasts for bytes32;
    using InterchainAccountMessage for bytes;

    // ============ Constants ============

    address internal immutable implementation;
    bytes32 internal immutable bytecodeHash;

    // ============ Public Storage ============
    /// @notice A mapping of commitments to the ICA that should execute the revealed calldata
    /// @dev The commitment is only stored if a `COMMITMENT` message was processed for it
    mapping(bytes32 commitment => OwnableMulticall ICA)
        public verifiedCommitments;

    // ============ Upgrade Gap ============
    uint256[49] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when an interchain call is dispatched to a remote domain
     * @param destination The destination domain on which to make the call
     * @param router The address of the remote router
     * @param config The account config containing the owner, ISM, and salt
     */
    event RemoteCallDispatched(
        uint32 indexed destination,
        bytes32 router,
        AccountConfig config
    );

    /**
     * @notice Emitted when an interchain call commitment is dispatched to a remote domain
     * @param destination The destination domain on which to make the call
     * @param router The address of the remote router
     * @param config The account config containing the owner, ISM, and salt
     */
    event CommitRevealDispatched(
        bytes32 indexed commitment,
        uint32 indexed destination,
        bytes32 router,
        AccountConfig config
    );

    event CommitmentRevealed(bytes32 indexed commitment);

    /**
     * @notice Emitted when an interchain account contract is deployed
     * @param account The address of the proxy account that was created
     * @param origin The domain of the chain where the message was sent from
     * @param router The router on the origin domain
     * @param config The account config containing the owner, ISM, and salt
     */
    event InterchainAccountCreated(
        address indexed account,
        uint32 origin,
        bytes32 router,
        AccountConfig config
    );

    // ============ Constructor ============
    constructor(
        address _mailbox,
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) Router(_mailbox) {
        setHook(_hook);
        setInterchainSecurityModule(_interchainSecurityModule);
        _transferOwnership(_owner);

        bytes memory bytecode = _implementationBytecode(address(this));
        implementation = Create2.deploy(0, bytes32(0), bytecode);
        bytecodeHash = _proxyBytecodeHash(implementation);
    }

    // ============ External Functions ============

    /**
     * @notice Dispatches a single remote call to be made by an owner's
     * interchain account on the destination domain
     * @dev Uses the default router and ISM addresses for the destination
     * domain, reverting if none have been configured
     * @param _destination The remote domain of the chain to make calls on
     * @param _gasLimit The gas limit that the call will consume
     * @param _to The address of the contract to call
     * @param _value The value to include in the call
     * @param _data The calldata
     * @return The Hyperlane message ID
     */
    function callRemote(
        uint32 _destination,
        uint256 _gasLimit,
        address _to,
        uint256 _value,
        bytes calldata _data
    ) external payable returns (bytes32) {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(_to, _value, _data);
        return callRemote(_destination, _gasLimit, calls);
    }

    /**
     * @notice Dispatches a batch of calls to be executed on a remote chain by
     *         the caller’s interchain account, using the router’s default configuration.
     * @param _destination The destination domain identifier.
     * @param _gasLimit    The gas limit that the remote execution may consume.
     * @param _calls       Array of low‑level calls to relay.
     * @return             The Hyperlane message ID corresponding to the dispatched message.
     */
    function callRemote(
        uint32 _destination,
        uint256 _gasLimit,
        CallLib.Call[] memory _calls
    ) public payable returns (bytes32) {
        return
            callRemoteAdvanced(
                _destination,
                routers(_destination),
                bytes32(0),
                bytes32(0),
                _calls,
                hook,
                _defaultHookMetadata(_gasLimit)
            );
    }

    /**
     * @notice Variant of {callRemote} that lets the caller specify a namespace (`_salt`)
     *         so multiple interchain accounts can coexist for the same owner.
     * @param _destination Destination domain identifier.
     * @param _salt        Namespace label (CREATE2 salt) used to derive a unique account.
     * @param _gasLimit    Gas limit for the remote call batch.
     * @param _calls       Calls to execute via the interchain account.
     * @return             The Hyperlane message ID emitted by the Mailbox.
     */
    function callRemoteNamespaced(
        uint32 _destination,
        bytes32 _salt,
        uint256 _gasLimit,
        CallLib.Call[] memory _calls
    ) public payable returns (bytes32) {
        return
            callRemoteAdvanced(
                _destination,
                routers(_destination),
                bytes32(0),
                _salt,
                _calls,
                hook,
                _defaultHookMetadata(_gasLimit)
            );
    }

    /**
     * @notice Fully‑configurable helper for dispatching remote calls. Allows
     *         explicit overrides for the destination router, ISM, namespace salt,
     *         and post‑dispatch hook.
     * @param _destination  Destination domain identifier.
     * @param _router       Remote router address (as bytes32) that should receive the message.
     * @param _ism          Interchain Security Module to associate with the derived account
     *                       (pass 0x0 to accept the router’s default).
     * @param _salt         Additional namespace salt for deterministic account derivation.
     * @param _calls        Calls to execute on the destination chain.
     * @param _hook         Optional post‑dispatch hook contract.
     * @param _hookMetadata Opaque metadata blob understood by the hook.
     * @return              Hyperlane message ID for the dispatched message.
     */
    function callRemoteAdvanced(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes32 _salt,
        CallLib.Call[] memory _calls,
        IPostDispatchHook _hook,
        bytes memory _hookMetadata
    ) public payable returns (bytes32) {
        AccountConfig memory accountConfig = AccountConfig({
            owner: msg.sender.addressToBytes32(),
            ism: _ism,
            salt: _salt
        });
        emit RemoteCallDispatched(_destination, _router, accountConfig);
        return
            mailbox.dispatch{value: msg.value}(
                _destination,
                _router,
                InterchainAccountMessageCalls.encode(accountConfig, _calls),
                _hookMetadata,
                _hook
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
        MessageType _messageType = _message.messageType();

        if (_messageType == MessageType.REVEAL) {
            bytes32 _commitment = InterchainAccountMessageReveal.commitment(
                _message
            );
            // If the message is a reveal, we don't do any derivation of the ica address
            // The commitment should be executed in the `verify` method of the CCIP read ISM that verified this message
            // so here we just check that commitment -> ICA association has been cleared
            require(
                verifiedCommitments[_commitment] ==
                    OwnableMulticall(payable(address(0))),
                "Commitment was not executed"
            );
            return;
        }

        AccountConfig memory accountConfig = _message.accountConfig();
        OwnableMulticall account = getDeployedInterchainAccount(
            _origin,
            _sender,
            accountConfig
        );

        if (_messageType == MessageType.COMMITMENT) {
            bytes32 commitment = InterchainAccountMessageCommitment.commitment(
                _message
            );
            verifiedCommitments[commitment] = account;
        } else {
            account.multicall{value: msg.value}(
                InterchainAccountMessageCalls.calls(_message)
            );
        }
    }

    // ============ External Functions ============
    /**
     * @notice Computes (without deploying) the address of the caller’s interchain
     *         account on the local chain for a given origin and configuration.
     * @param _origin        The origin domain where messages will originate.
     * @param _accountConfig Account configuration (owner, ISM, salt).
     * @return account       Predicted local interchain account address.
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        AccountConfig memory _accountConfig
    ) external view returns (address payable account) {
        (, account) = getLocalInterchainAccount(
            _origin,
            routers(_origin),
            _accountConfig
        );
    }

    /**
     * @notice Returns the caller’s interchain account on the local chain,
     *         lazily deploying it with CREATE2 if it does not already exist.
     * @param _origin        Origin domain of the account.
     * @param _accountConfig Configuration struct (owner, ISM, salt).
     * @return               Reference to the deployed {OwnableMulticall} proxy.
     */
    function getDeployedInterchainAccount(
        uint32 _origin,
        AccountConfig memory _accountConfig
    ) external returns (OwnableMulticall) {
        return
            getDeployedInterchainAccount(
                _origin,
                routers(_origin),
                _accountConfig
            );
    }

    /**
     * @notice Predicts the address of the caller’s interchain account on a
     *         destination chain using this router’s domain mapping.
     * @param destination    Destination domain identifier.
     * @param _accountConfig Configuration struct (owner, ISM, salt).
     * @return account       Predicted interchain account address on the destination chain.
     */
    function getRemoteInterchainAccount(
        uint32 destination,
        AccountConfig calldata _accountConfig
    ) external view returns (address) {
        return
            getRemoteInterchainAccount(
                routers(destination).bytes32ToAddress(),
                _accountConfig
            );
    }

    /**
     * @notice Returns (deploying if necessary) the caller’s interchain account
     *         contract for the given origin domain and router address.
     * @dev    Low‑level helper used by the external {getDeployedInterchainAccount}
     *         overload.  Computes the CREATE2 salt, predicts the account address,
     *         and deploys the proxy on‑demand.
     * @param _origin        Remote origin domain of the account.
     * @param _router        Remote origin router address (as bytes32).
     * @param _accountConfig Configuration struct (owner, ISM, salt).
     * @return               Reference to the deployed {OwnableMulticall} proxy.
     */
    function getDeployedInterchainAccount(
        uint32 _origin,
        bytes32 _router,
        AccountConfig memory _accountConfig
    ) public returns (OwnableMulticall) {
        (
            bytes32 _deploySalt,
            address payable _account
        ) = getLocalInterchainAccount(_origin, _router, _accountConfig);
        if (!Address.isContract(_account)) {
            bytes memory _bytecode = MinimalProxy.bytecode(implementation);
            _account = payable(Create2.deploy(0, _deploySalt, _bytecode));
            emit InterchainAccountCreated(
                _account,
                _origin,
                _router,
                _accountConfig
            );
        }
        return OwnableMulticall(_account);
    }

    /**
     * @notice Computes the deterministic CREATE2 salt and the resulting local
     *         interchain account address for the given origin domain, router,
     *         and account configuration—without deploying anything.
     * @param _origin        Remote origin domain.
     * @param _router        Origin router address (as bytes32).
     * @param _accountConfig Configuration struct (owner, ISM, salt).
     * @return salt          CREATE2 salt that will be used for deployment.
     * @return account       Predicted account address on the local chain.
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        bytes32 _router,
        AccountConfig memory _accountConfig
    ) public view returns (bytes32 salt, address payable account) {
        salt = _getSalt(_origin, _router, _accountConfig);
        account = getLocalInterchainAccount(salt);
    }

    /**
     * @notice Predicts the address of the caller’s interchain account on a
     *         destination chain when the destination router address is supplied
     *         explicitly (rather than via the {routers} mapping).
     * @param _router        Destination router address.
     * @param _accountConfig Configuration struct (owner, ISM, salt).
     * @return account       Predicted interchain account address on the destination chain.
     */
    function getRemoteInterchainAccount(
        address _router,
        AccountConfig calldata _accountConfig
    ) public view returns (address) {
        // replicate router constructor Create2 derivation
        address _implementation = Create2.computeAddress(
            bytes32(0),
            keccak256(_implementationBytecode(_router)),
            _router
        );

        bytes32 _bytecodeHash = _proxyBytecodeHash(_implementation);
        bytes32 _salt = _getSalt(
            localDomain,
            address(this).addressToBytes32(),
            _accountConfig
        );

        return Create2.computeAddress(_salt, _bytecodeHash, _router);
    }

    /**
     * @notice Returns the fee required to cover the cost of a remote call.
     * @param _destination The domain of the destination router.
     * @param _gasLimit The gas limit to override with.
     */
    function quoteCallRemote(
        uint32 _destination,
        uint256 _gasLimit
    ) external view returns (uint256) {
        bytes memory _messageBody = InterchainAccountMessageCalls.encode(
            AccountConfig({
                owner: msg.sender.addressToBytes32(),
                ism: bytes32(0),
                salt: bytes32(0)
            }),
            new CallLib.Call[](0)
        );
        return
            _Router_quoteDispatch(
                _destination,
                _messageBody,
                _defaultHookMetadata(_gasLimit),
                address(hook)
            );
    }

    function callRemoteCommitReveal(
        uint32 _destination,
        uint256 _gasLimit,
        bytes32 _commitment
    ) public payable returns (bytes32 _commitmentMsgId, bytes32 _revealMsgId) {
        return
            callRemoteCommitRevealAdvanced(
                _destination,
                routers(_destination),
                bytes32(0),
                bytes32(0),
                bytes32(0),
                _commitment,
                hook,
                _defaultHookMetadata(_gasLimit)
            );
    }

    function callRemoteCommitRevealNamespaced(
        uint32 _destination,
        bytes32 _salt,
        uint256 _gasLimit,
        bytes32 _commitment
    ) public payable returns (bytes32 _commitmentMsgId, bytes32 _revealMsgId) {
        return
            callRemoteCommitRevealAdvanced(
                _destination,
                routers(_destination),
                _salt,
                bytes32(0),
                bytes32(0),
                _commitment,
                hook,
                _defaultHookMetadata(_gasLimit)
            );
    }

    uint256 private constant COMMITMENT_GAS_LIMIT = 20_000;

    function callRemoteCommitRevealAdvanced(
        uint32 _destination,
        bytes32 _router,
        bytes32 _accountSalt,
        bytes32 _accountIsm,
        bytes32 _offchainLookupIsm,
        bytes32 _commitment,
        IPostDispatchHook _hook,
        bytes memory _hookMetadata
    ) public payable returns (bytes32 _commitmentMsgId, bytes32 _revealMsgId) {
        bytes memory commitMetadata = StandardHookMetadata.overrideGasLimit(
            COMMITMENT_GAS_LIMIT
        );
        uint256 commitFee = mailbox.quoteDispatch(
            _destination,
            _router,
            new bytes(0),
            commitMetadata
        );
        require(msg.value >= commitFee, "Insufficient value for commit fee");

        AccountConfig memory accountConfig = AccountConfig({
            owner: msg.sender.addressToBytes32(),
            ism: _accountIsm,
            salt: _accountSalt
        });
        emit CommitRevealDispatched(
            _commitment,
            _destination,
            _router,
            accountConfig
        );

        _commitmentMsgId = mailbox.dispatch{value: commitFee}(
            _destination,
            _router,
            InterchainAccountMessageCommitment.encode(
                accountConfig,
                _commitment
            ),
            commitMetadata,
            _hook
        );

        _revealMsgId = mailbox.dispatch{value: msg.value - commitFee}(
            _destination,
            _router,
            InterchainAccountMessageReveal.encode(
                _offchainLookupIsm,
                _commitment
            ),
            _hookMetadata,
            _hook
        );
    }

    /// @dev The calls represented by the commitment can only be executed once.
    function revealAndExecute(
        CallLib.Call[] calldata _calls,
        bytes32 _salt
    ) external payable {
        bytes32 _givenCommitment = keccak256(abi.encode(_salt, _calls));
        OwnableMulticall ica = verifiedCommitments[_givenCommitment];

        require(address(payable(ica)) != address(0), "Invalid Reveal");
        delete verifiedCommitments[_givenCommitment];
        emit CommitmentRevealed(_givenCommitment);

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

    // ============ Private Functions ============
    /**
     * @notice Returns the salt used to deploy an interchain account
     * @param _origin The remote origin domain of the interchain account
     * @param _router The remote origin InterchainAccountRouter
     * @param _accountConfig The account config containing the owner, ISM, and salt
     * @return The CREATE2 salt used for deploying the interchain account
     */
    function _getSalt(
        uint32 _origin,
        bytes32 _router,
        AccountConfig memory _accountConfig
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(_origin, _router, abi.encode(_accountConfig))
            );
    }

    /**
     * @notice Returns the address of the interchain account on the local chain
     * @param _salt The CREATE2 salt used for deploying the interchain account
     * @return The address of the interchain account
     */
    function getLocalInterchainAccount(
        bytes32 _salt
    ) private view returns (address payable) {
        return payable(Create2.computeAddress(_salt, bytecodeHash));
    }

    function _defaultHookMetadata(
        uint256 _gasLimit
    ) private view returns (bytes memory) {
        return
            StandardHookMetadata.formatMetadata(
                0,
                _gasLimit,
                msg.sender // refund address
            );
    }
}
