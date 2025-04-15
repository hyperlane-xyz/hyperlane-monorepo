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
import {EnumerableMapExtended} from "../libs/EnumerableMapExtended.sol";
import {Router} from "../client/Router.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/*
 * @title A contract that allows accounts on chain A to call contracts via a
 * proxy contract on chain B.
 */
contract InterchainAccountRouter is Router {
    // ============ Libraries ============

    using TypeCasts for address;
    using TypeCasts for bytes32;

    struct AccountOwner {
        uint32 origin;
        bytes32 owner; // remote owner
    }

    // ============ Constants ============

    address internal implementation;
    bytes32 internal bytecodeHash;

    // ============ Public Storage ============
    mapping(uint32 => bytes32) public isms;
    // reverse lookup from the ICA account to the remote owner
    mapping(address => AccountOwner) public accountOwners;

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
     * @param origin The domain of the chain where the message was sent from
     * @param owner The address of the account that sent the message
     * @param ism The address of the local ISM
     * @param account The address of the proxy account that was created
     */
    event InterchainAccountCreated(
        uint32 indexed origin,
        bytes32 indexed owner,
        address ism,
        address account
    );

    // ============ Constructor ============

    constructor(address _mailbox) Router(_mailbox) {}

    // ============ Initializers ============

    /**
     * @notice Initializes the contract with HyperlaneConnectionClient contracts
     * @param _customHook used by the Router to set the hook to override with
     * @param _interchainSecurityModule The address of the local ISM contract
     * @param _owner The address with owner privileges
     */
    function initialize(
        address _customHook,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        _MailboxClient_initialize(
            _customHook,
            _interchainSecurityModule,
            _owner
        );

        implementation = address(new OwnableMulticall(address(this)));
        // cannot be stored immutably because it is dynamically sized
        bytes memory _bytecode = MinimalProxy.bytecode(implementation);
        bytecodeHash = keccak256(_bytecode);
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

    function setHook(
        address _hook
    ) public override onlyContractOrNull(_hook) onlyOwner {
        hook = IPostDispatchHook(_hook);
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
        (
            bytes32 _owner,
            bytes32 _ism,
            CallLib.Call[] memory _calls,
            bytes32 _salt
        ) = InterchainAccountMessage.decode(_message);

        OwnableMulticall _interchainAccount = getDeployedInterchainAccount(
            _origin,
            _owner,
            _sender,
            _ism.bytes32ToAddress(),
            _salt
        );
        _interchainAccount.multicall{value: msg.value}(_calls);
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
            accountOwners[_account] = AccountOwner(_origin, _owner);
            emit InterchainAccountCreated(_origin, _owner, _ism, _account);
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
        // Derives the address of the first contract deployed by _router using
        // the CREATE opcode.
        address _implementation = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xd6),
                            bytes1(0x94),
                            _router,
                            bytes1(0x01)
                        )
                    )
                )
            )
        );
        bytes memory _proxyBytecode = MinimalProxy.bytecode(_implementation);
        bytes32 _bytecodeHash = keccak256(_proxyBytecode);
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
                bytes32(0)
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
        bytes memory _body = InterchainAccountMessage.encode(
            msg.sender,
            _ism,
            _calls,
            _userSalt
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

    // ============ Internal Functions ============

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
        require(
            _router != InterchainAccountMessage.EMPTY_SALT,
            "no router specified for destination"
        );
        emit RemoteCallDispatched(_destination, msg.sender, _router, _ism);
        return
            mailbox.dispatch{value: msg.value}(
                _destination,
                _router,
                _body,
                new bytes(0),
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
     */
    function _dispatchMessageWithMetadata(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes memory _body,
        bytes memory _hookMetadata
    ) private returns (bytes32) {
        require(
            _router != InterchainAccountMessage.EMPTY_SALT,
            "no router specified for destination"
        );
        emit RemoteCallDispatched(_destination, msg.sender, _router, _ism);
        return
            mailbox.dispatch{value: msg.value}(
                _destination,
                _router,
                _body,
                _hookMetadata,
                hook
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
