// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {OwnableMulticall} from "../OwnableMulticall.sol";
import {HyperlaneConnectionClient} from "../HyperlaneConnectionClient.sol";
import {IRouter} from "../../interfaces/IRouter.sol";
import {IInterchainAccountRouter} from "../../interfaces/middleware/IInterchainAccountRouter.sol";
import {InterchainAccountMessage} from "../libs/middleware/InterchainAccountMessage.sol";
import {MinimalProxy} from "../libs/MinimalProxy.sol";
import {CallLib} from "../libs/Call.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {OverridableEnumerableMap} from "../libs/OverridableEnumerableMap.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/*
 * @title A contract that allows accounts on chain A to call contracts via a
 * proxy contract on chain B.
 */
contract InterchainAccountRouter is
    HyperlaneConnectionClient,
    IRouter,
    IInterchainAccountRouter
{
    // ============ Libraries ============

    using TypeCasts for address;
    using TypeCasts for bytes32;

    // ============ Constants ============

    address internal immutable implementation;
    bytes32 internal immutable bytecodeHash;

    // ============ Public Storage ============
    OverridableEnumerableMap.UintToBytes32OverridableMap private routersMap;
    OverridableEnumerableMap.UintToBytes32OverridableMap private ismsMap;

    // ============ Events ============

    /**
     * @notice Emitted when a default router is set for a remote domain
     * @param domain The remote domain
     * @param router The address of the remote router
     */
    event RemoteRouterEnrolled(uint32 indexed domain, bytes32 indexed router);

    /**
     * @notice Emitted when a default ISM is set for a remote domain
     * @param domain The remote domain
     * @param ism The address of the remote ISM
     */
    event RemoteIsmEnrolled(uint32 indexed domain, bytes32 indexed ism);

    /**
     * @notice Emitted when an owner sets a router override for a remote domain
     * @param domain The remote domain
     * @param router The address of the remote router
     * @param owner The owner of the interchain account
     */
    event RemoteRouterOverridden(
        uint32 indexed domain,
        bytes32 indexed router,
        address indexed owner
    );

    /**
     * @notice Emitted when an owner sets an ISM override for a remote domain
     * @param domain The remote domain
     * @param ism The address of the remote ISM
     * @param owner The owner of the interchain account
     */
    event RemoteIsmOverridden(
        uint32 indexed domain,
        bytes32 indexed ism,
        address indexed owner
    );

    /**
     * @notice Emitted when an interchain call is dispatched to a remote domain
     * @param destination The destination domain on which to make the call
     * @param owner The local owner of the remote ICA
     * @param router The address of the remote router
     * @param ism The address of the remote ISM
     */
    event InterchainCallDispatched(
        uint32 indexed destination,
        address indexed owner,
        bytes32 router,
        bytes32 ism,
        bytes32 messageId
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

    /**
     * @notice Constructor deploys a relay (OwnableMulticall.sol) contract that
     * will be cloned for each interchain account
     */
    constructor() {
        implementation = address(new OwnableMulticall());
        // cannot be stored immutably because it is dynamically sized
        bytes memory _bytecode = MinimalProxy.bytecode(implementation);
        bytecodeHash = keccak256(_bytecode);
    }

    // ============ Initializers ============

    /**
     * @notice Initializes the contract with HyperlaneConnectionClient contracts
     * @param _mailbox The address of the mailbox contract
     * @param _interchainGasPaymaster Unused but required by HyperlaneConnectionClient
     * @param _interchainSecurityModule The address of the local ISM contract
     * @param _owner The address with owner privileges
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

    // ============ External Functions ============

    /**
     * @notice Registers the address of many remote InterchainAccountRouter
     * contracts to use as a default when making interchain calls
     * @param _destinations The remote domains
     * @param _routers The addresses of the remote InterchainAccountRouters
     */
    function enrollRemoteRouters(
        uint32[] calldata _destinations,
        bytes32[] calldata _routers
    ) external {
        require(_destinations.length == _routers.length, "!length");
        for (uint256 i = 0; i < _destinations.length; i += 1) {
            enrollRemoteRouter(_destinations[i], _routers[i]);
        }
    }

    /**
     * @notice Registers the address of remote InterchainAccountRouter
     * and ISM contracts to use as a default when msg.sender makes
     * interchain calls
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     * @param _ism The address of the remote ISM
     */
    function overrideRemoteRouterAndIsm(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism
    ) external {
        OverridableEnumerableMap.setOverride(
            routersMap,
            msg.sender,
            _destination,
            _router
        );
        OverridableEnumerableMap.setOverride(
            ismsMap,
            msg.sender,
            _destination,
            _ism
        );
        emit RemoteRouterOverridden(_destination, _router, msg.sender);
        emit RemoteIsmOverridden(_destination, _ism, msg.sender);
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by a owner's
     * interchain account on the destination domain
     * @dev Uses the default router and ISM addresses for the destination
     * domain, reverting if none have been configured
     * @dev Recommend using CallLib.build to format the interchain calls.
     * @param _destination The remote domain of the chain to make calls on
     * @param _calls The sequence of calls to make
     * @return The Hyperlane message ID
     */
    function callRemote(uint32 _destination, CallLib.Call[] calldata _calls)
        external
        returns (bytes32)
    {
        (bytes32 _router, bytes32 _ism) = getRemoteRouterAndIsm(
            _destination,
            msg.sender
        );
        require(_router != bytes32(0), "no router specified for destination");
        return callRemoteWithOverrides(_destination, _router, _ism, _calls);
    }

    /**
     * @notice Handles dispatched messages by relaying calls to the interchain account.
     * @param _origin The origin domain of the interchain account.
     * @param _message The InterchainAccountMessage containing the account
     * owner, ISM, and sequence of calls to be relayed.
     */
    function handle(
        uint32 _origin,
        bytes32, // router sender
        bytes calldata _message
    ) external onlyMailbox {
        OwnableMulticall interchainAccount = _getDeployedInterchainAccount(
            _origin,
            InterchainAccountMessage.owner(_message),
            InterchainAccountMessage.ismAddress(_message)
        );
        interchainAccount.proxyCalls(InterchainAccountMessage.calls(_message));
    }

    /**
     * @notice Returns the local address of an interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _ism The local address of the ISM
     * @return The local address of the interchain account
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        address _owner,
        address _ism
    ) external view returns (OwnableMulticall) {
        bytes32 _ownerAsBytes32 = TypeCasts.addressToBytes32(_owner);
        return getLocalInterchainAccount(_origin, _ownerAsBytes32, _ism);
    }

    /**
     * @notice Returns the domains which have default remote routers enrolled
     * @dev This does not include domains which may have user-specific overrides
     * @return The domains which have default remote routers enrolled
     */
    function domains() external view returns (uint32[] memory) {
        bytes32[] storage rawKeys = OverridableEnumerableMap.keysDefault(
            routersMap
        );
        uint32[] memory keys = new uint32[](rawKeys.length);
        for (uint256 i = 0; i < rawKeys.length; i++) {
            keys[i] = uint32(uint256(rawKeys[i]));
        }
        return keys;
    }

    /**
     * @notice Returns the default router address for a remote domain
     * @param _domain The remote domain
     */
    function routers(uint32 _domain) external view returns (bytes32) {
        if (OverridableEnumerableMap.containsDefault(routersMap, _domain)) {
            return OverridableEnumerableMap.getDefault(routersMap, _domain);
        } else {
            return bytes32(0); // for backwards compatibility with storage mapping
        }
    }

    // ============ Public Functions ============

    /**
     * @notice Registers the address of a remote InterchainAccountRouter
     * contract to use as a default when making interchain calls
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     */
    function enrollRemoteRouter(uint32 _destination, bytes32 _router) public {
        enrollRemoteRouterAndIsm(_destination, _router, bytes32(0));
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
    ) public onlyOwner {
        require(_router != bytes32(0), "invalid router address");
        require(
            !OverridableEnumerableMap.containsDefault(routersMap, _destination),
            "router and ISM defaults are immutable once set"
        );
        OverridableEnumerableMap.setDefault(routersMap, _destination, _router);
        OverridableEnumerableMap.setDefault(ismsMap, _destination, _ism);
        emit RemoteRouterEnrolled(_destination, _router);
        emit RemoteIsmEnrolled(_destination, _ism);
    }

    /**
     * @notice Dispatches a sequence of remote calls to be made by a owner's
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
    ) public returns (bytes32) {
        bytes memory _body = InterchainAccountMessage.format(
            msg.sender,
            _ism,
            _calls
        );
        bytes32 _id = mailbox.dispatch(_destination, _router, _body);
        emit InterchainCallDispatched(
            _destination,
            msg.sender,
            _router,
            _ism,
            _id
        );
        return _id;
    }

    /**
     * @notice Returns the remote router and ISM address that are currently
     * configured for an ICA owner on the specified domain
     * @param _destination The remote domain
     * @param _owner The local ICA owner
     */
    function getRemoteRouterAndIsm(uint32 _destination, address _owner)
        public
        view
        returns (bytes32, bytes32)
    {
        bytes32 _router = OverridableEnumerableMap.get(
            routersMap,
            _owner,
            _destination
        );
        bytes32 _ism = OverridableEnumerableMap.get(
            ismsMap,
            _owner,
            _destination
        );
        return (_router, _ism);
    }

    /**
     * @notice Returns the local address of an interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _ism The local address of the ISM
     * @return The local address of the interchain account
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        address _ism
    ) public view returns (OwnableMulticall) {
        return
            OwnableMulticall(
                _getInterchainAccount(_salt(_origin, _owner, _ism))
            );
    }

    // ============ Private Functions ============

    /**
     * @notice Returns and deploys (if not already) an interchain account
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @return The address of the interchain account
     */
    function _getDeployedInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        address _ism
    ) private returns (OwnableMulticall) {
        bytes32 salt = _salt(_origin, _owner, _ism);
        address payable _account = _getInterchainAccount(salt);
        if (!Address.isContract(_account)) {
            bytes memory bytecode = MinimalProxy.bytecode(implementation);
            _account = payable(Create2.deploy(0, salt, bytecode));
            emit InterchainAccountCreated(_origin, _owner, _ism, _account);
            // transfers ownership to this contract
            OwnableMulticall(_account).initialize();
        }
        return OwnableMulticall(_account);
    }

    /**
     * @notice Returns the salt used to deploy an interchain account
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _ism The local address of the ISM
     * @return The CREATE2 salt used for deploying the interchain account
     */
    function _salt(
        uint32 _origin,
        bytes32 _owner,
        address _ism
    ) private pure returns (bytes32) {
        return bytes32(abi.encodePacked(_origin, _owner, _ism));
    }

    /**
     * @notice Returns the address of the interchain account on the local chain
     * @param salt The CREATE2 salt used for deploying the interchain account
     * @return The address of the interchain account
     */
    function _getInterchainAccount(bytes32 salt)
        private
        view
        returns (address payable)
    {
        return payable(Create2.computeAddress(salt, bytecodeHash));
    }
}
