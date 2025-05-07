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
import {AccountConfig, InterchainAccountMessage} from "./libs/InterchainAccountMessage.sol";
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

    // ============ Constants ============

    address public immutable implementation;
    bytes32 public immutable bytecodeHash;

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
     * @param router The address of the remote router
     * @param config The account config containing the owner, ISM, and salt
     */
    event RemoteCallDispatched(
        uint32 indexed destination,
        bytes32 router,
        AccountConfig config
    );

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
                InterchainAccountMessage.encode(accountConfig, _calls),
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
        (
            AccountConfig memory _accountConfig,
            CallLib.Call[] memory _calls
        ) = InterchainAccountMessage.decode(_message);

        OwnableMulticall _interchainAccount = getDeployedInterchainAccount(
            _origin,
            _sender,
            _accountConfig
        );
        _interchainAccount.multicall{value: msg.value}(_calls);
    }

    // ============ External Functions ============
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

    // ============ Router overrides ============
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

    function getLocalInterchainAccount(
        uint32 _origin,
        bytes32 _router,
        AccountConfig memory _accountConfig
    ) public view returns (bytes32 salt, address payable account) {
        salt = _getSalt(_origin, _router, _accountConfig);
        account = getLocalInterchainAccount(salt);
    }

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
        bytes memory _messageBody = InterchainAccountMessage.encode(
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

    function _implementationBytecode(
        address router
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                type(OwnableMulticall).creationCode,
                abi.encode(router)
            );
    }

    function _proxyBytecodeHash(
        address _implementation
    ) private pure returns (bytes32) {
        return keccak256(MinimalProxy.bytecode(_implementation));
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
