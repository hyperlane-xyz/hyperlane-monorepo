// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {OwnableMulticall} from "../OwnableMulticall.sol";
import {HyperlaneConnectionClient} from "../HyperlaneConnectionClient.sol";
import {IRouter} from "../interfaces/IRouter.sol";
import {IInterchainAccountRouter} from "../interfaces/middleware/IInterchainAccountRouter.sol";
import {InterchainAccountMessage} from "../libs/middleware/InterchainAccountMessage.sol";
import {MinimalProxy} from "../libs/MinimalProxy.sol";
import {CallLib} from "../libs/Call.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {EnumerableMapExtended} from "../libs/EnumerableMapExtended.sol";

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

    uint32 internal immutable localDomain;
    address internal implementation;
    bytes32 internal bytecodeHash;

    // ============ Private Storage ============
    uint32[] private _domains;

    // ============ Public Storage ============
    mapping(uint32 => bytes32) public routers;
    mapping(uint32 => bytes32) public isms;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a default router is set for a remote domain
     * @param domain The remote domain
     * @param router The address of the remote router
     */
    event RemoteRouterEnrolled(uint32 indexed domain, bytes32 router);

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

    /**
     * @notice Constructor deploys a relay (OwnableMulticall.sol) contract that
     * will be cloned for each interchain account.
     * @param _localDomain The Hyperlane domain ID on which this contract is
     * deployed.
     */
    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
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
        require(localDomain == mailbox.localDomain(), "domain mismatch");

        implementation = address(new OwnableMulticall(address(this)));
        // cannot be stored immutably because it is dynamically sized
        bytes memory _bytecode = MinimalProxy.bytecode(implementation);
        bytecodeHash = keccak256(_bytecode);
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
    ) external onlyOwner {
        require(_destinations.length == _routers.length, "!length");
        for (uint256 i = 0; i < _destinations.length; i += 1) {
            _enrollRemoteRouterAndIsm(
                _destinations[i],
                _routers[i],
                bytes32(0)
            );
        }
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
     * @return The Hyperlane message ID
     */
    function callRemote(
        uint32 _destination,
        address _to,
        uint256 _value,
        bytes memory _data
    ) external returns (bytes32) {
        bytes32 _router = routers[_destination];
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
     * @notice Dispatches a sequence of remote calls to be made by an owner's
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
        bytes32 _router = routers[_destination];
        bytes32 _ism = isms[_destination];
        return callRemoteWithOverrides(_destination, _router, _ism, _calls);
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
    ) external onlyMailbox {
        (
            bytes32 _owner,
            bytes32 _ism,
            CallLib.Call[] memory _calls
        ) = InterchainAccountMessage.decode(_message);

        OwnableMulticall _interchainAccount = getDeployedInterchainAccount(
            _origin,
            _owner,
            _sender,
            TypeCasts.bytes32ToAddress(_ism)
        );
        _interchainAccount.multicall(_calls);
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
        bytes32 _routerAsBytes32 = TypeCasts.addressToBytes32(_router);
        bytes32 _ownerAsBytes32 = TypeCasts.addressToBytes32(_owner);
        return
            getLocalInterchainAccount(
                _origin,
                _ownerAsBytes32,
                _routerAsBytes32,
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
    function getRemoteInterchainAccount(uint32 _destination, address _owner)
        external
        view
        returns (address)
    {
        address _router = TypeCasts.bytes32ToAddress(routers[_destination]);
        address _ism = TypeCasts.bytes32ToAddress(isms[_destination]);
        return getRemoteInterchainAccount(_owner, _router, _ism);
    }

    function domains() external view returns (uint32[] memory) {
        return _domains;
    }

    // ============ Public Functions ============

    /**
     * @notice Registers the address of a remote InterchainAccountRouter
     * contract to use as a default when making interchain calls
     * @param _destination The remote domain
     * @param _router The address of the remote InterchainAccountRouter
     */
    function enrollRemoteRouter(uint32 _destination, bytes32 _router)
        public
        onlyOwner
    {
        _enrollRemoteRouterAndIsm(_destination, _router, bytes32(0));
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
        _enrollRemoteRouterAndIsm(_destination, _router, _ism);
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
    ) public returns (bytes32) {
        bytes memory _body = InterchainAccountMessage.encode(
            msg.sender,
            _ism,
            _calls
        );
        return _dispatchMessage(_destination, _router, _ism, _body);
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
        address _owner,
        address _router,
        address _ism
    ) public returns (OwnableMulticall) {
        return
            getDeployedInterchainAccount(
                _origin,
                TypeCasts.addressToBytes32(_owner),
                TypeCasts.addressToBytes32(_router),
                _ism
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
        address _ism
    ) public returns (OwnableMulticall) {
        bytes32 _salt = _getSalt(
            _origin,
            _owner,
            _router,
            TypeCasts.addressToBytes32(_ism)
        );
        address payable _account = _getLocalInterchainAccount(_salt);
        if (!Address.isContract(_account)) {
            bytes memory _bytecode = MinimalProxy.bytecode(implementation);
            _account = payable(Create2.deploy(0, _salt, _bytecode));
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
            OwnableMulticall(
                _getLocalInterchainAccount(
                    _getSalt(
                        _origin,
                        _owner,
                        _router,
                        TypeCasts.addressToBytes32(_ism)
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
            TypeCasts.addressToBytes32(_owner),
            TypeCasts.addressToBytes32(address(this)),
            TypeCasts.addressToBytes32(_ism)
        );
        return Create2.computeAddress(_salt, _bytecodeHash, _router);
    }

    // ============ Private Functions ============

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
        require(_router != bytes32(0), "invalid router address");
        require(
            routers[_destination] == bytes32(0),
            "router and ISM defaults are immutable once set"
        );
        _domains.push(_destination);
        routers[_destination] = _router;
        isms[_destination] = _ism;
        emit RemoteRouterEnrolled(_destination, _router);
        emit RemoteIsmEnrolled(_destination, _ism);
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
        require(_router != bytes32(0), "no router specified for destination");
        emit RemoteCallDispatched(_destination, msg.sender, _router, _ism);
        return mailbox.dispatch(_destination, _router, _body);
    }

    /**
     * @notice Returns the salt used to deploy an interchain account
     * @param _origin The remote origin domain of the interchain account
     * @param _owner The remote owner of the interchain account
     * @param _router The remote origin InterchainAccountRouter
     * @param _ism The local address of the ISM
     * @return The CREATE2 salt used for deploying the interchain account
     */
    function _getSalt(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        bytes32 _ism
    ) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(_origin, _owner, _router, _ism));
    }

    /**
     * @notice Returns the address of the interchain account on the local chain
     * @param _salt The CREATE2 salt used for deploying the interchain account
     * @return The address of the interchain account
     */
    function _getLocalInterchainAccount(bytes32 _salt)
        private
        view
        returns (address payable)
    {
        return payable(Create2.computeAddress(_salt, bytecodeHash));
    }
}
