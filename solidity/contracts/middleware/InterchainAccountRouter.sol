// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {OwnableMulticall} from "../OwnableMulticall.sol";
import {HyperlaneConnectionClient} from "../HyperlaneConnectionClient.sol";
import {IInterchainAccountRouter} from "../../interfaces/IInterchainAccountRouter.sol";
import {InterchainAccountMessage} from "../libs/middleware/InterchainAccountMessage.sol";
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
contract InterchainAccountRouter is
    HyperlaneConnectionClient,
    IInterchainAccountRouter
{
    // ============ Libraries ============

    using TypeCasts for address;
    using TypeCasts for bytes32;

    // ============ Constants ============

    address internal immutable implementation;
    bytes32 internal immutable bytecodeHash;

    // ============ Public Storage ============

    // Maps destination domain to global default configs
    mapping(uint32 => InterchainAccountConfig) globalDefaults;
    // Maps user address to overrides for global default configs
    mapping(address => mapping(uint32 => InterchainAccountConfig)) userDefaults;

    // ============ Events ============

    /**
     * @notice Emitted when an interchain account is created (first time message is sent from a given `origin`/`owner` pair)
     * @param origin The domain of the chain where the message was sent from
     * @param owner The address of the account that sent the message
     * @param account The address of the proxy account that was created
     */
    event InterchainAccountCreated(
        uint32 indexed origin,
        bytes32 owner,
        address account
    );

    // ============ Constructor ============

    /**
     * @notice Constructor deploys a relay (OwnableMulticall.sol) contract that will be cloned for each interchain account.
     */
    constructor() {
        implementation = address(new OwnableMulticall());
        // cannot be stored immutably because it is dynamically sized
        bytes memory bytecode = MinimalProxy.bytecode(implementation);
        bytecodeHash = keccak256(bytecode);
    }

    // ============ Initializers ============

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

    // ============ External Functions ============

    /**
     * @notice Dispatches a sequence of remote calls to be made by a owner's
     * interchain account on the destination domain.
     * @dev Uses the default router and ISM addresses for the destination
     * domain, reverting if none have been configured.
     * @dev Recommend using CallLib.build to format the interchain calls.
     * @param _destination The domain of the chain on which the calls
     * will be made
     * @param _calls The sequence of calls to make.
     * @return The Hyperlane message ID
     */
    function callRemote(uint32 _destination, CallLib.Call[] calldata _calls)
        external
        returns (bytes32)
    {
        InterchainAccountConfig memory _config = getInterchainAccountConfig(
            _destination,
            msg.sender
        );
        require(!_isEmpty(_config), "no default config");
        return
            mailbox.dispatch(
                _destination,
                _config.router,
                InterchainAccountMessage.format(msg.sender, _config.ism, _calls)
            );
    }

    function callRemote(
        uint32 _destination,
        InterchainAccountConfig calldata _config,
        CallLib.Call[] calldata _calls
    ) external returns (bytes32) {
        return
            mailbox.dispatch(
                _destination,
                _config.router,
                InterchainAccountMessage.format(msg.sender, _config.ism, _calls)
            );
    }

    /**
     * @notice Handles dispatched messages by relaying calls to the interchain account.
     * @param _origin The origin domain of the interchain account.
     * @param _message The ABI-encoded message containing the owner and the sequence of calls to be relayed.
     */
    function handle(
        uint32 _origin,
        bytes32, // router sender
        bytes calldata _message
    ) external {
        OwnableMulticall interchainAccount = _getDeployedInterchainAccount(
            _origin,
            InterchainAccountMessage.owner(_message),
            InterchainAccountMessage.ismAddress(_message)
        );
        interchainAccount.proxyCalls(InterchainAccountMessage.calls(_message));
    }

    function getLocalInterchainAccount(
        uint32 _origin,
        address _owner,
        address _ism
    ) external view returns (OwnableMulticall) {
        return
            getLocalInterchainAccount(
                _origin,
                TypeCasts.addressToBytes32(_owner),
                _ism
            );
    }

    /**
     * @notice Returns the address of the interchain account deployed on the
     * local chain.
     * @param _origin The origin domain of the interchain account.
     * @param _owner The parent account address on the origin domain.
     * @return The address of the interchain account.
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

    // ONLYOWNER!
    function setGlobalDefault(
        uint32 _destination,
        InterchainAccountConfig calldata _config
    ) external onlyOwner {
        require(_config.router != bytes32(0), "invalid router");
        require(_isEmpty(globalDefaults[_destination]), "immutable");
        globalDefaults[_destination] = _config;
    }

    function setUserDefault(
        uint32 _destination,
        InterchainAccountConfig calldata _config
    ) external {
        require(!_isEmpty(_config), "invalid router");
        userDefaults[msg.sender][_destination] = _config;
    }

    // ============ Private Functions ============

    /**
     * @notice Returns and deploys (if not already) an interchain account
     * @param _origin The origin domain of the interchain account.
     * @param _owner The parent account address on the origin domain.
     * @return The address of the interchain account.
     */
    function _getDeployedInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        address _ism
    ) private returns (OwnableMulticall) {
        bytes32 salt = _salt(_origin, _owner, _ism);
        address payable interchainAccount = _getInterchainAccount(salt);
        if (!Address.isContract(interchainAccount)) {
            bytes memory bytecode = MinimalProxy.bytecode(implementation);
            interchainAccount = payable(Create2.deploy(0, salt, bytecode));
            emit InterchainAccountCreated(_origin, _owner, interchainAccount);
            // transfers ownership to this contract
            OwnableMulticall(interchainAccount).initialize();
        }
        return OwnableMulticall(interchainAccount);
    }

    // TODO: Consistency, domain comes first
    function getInterchainAccountConfig(uint32 _destination, address _owner)
        public
        view
        returns (InterchainAccountConfig memory)
    {
        InterchainAccountConfig storage _userDefault = userDefaults[_owner][
            _destination
        ];
        return
            _isEmpty(_userDefault)
                ? globalDefaults[_destination]
                : _userDefault;
    }

    function _isEmpty(InterchainAccountConfig memory _config)
        private
        pure
        returns (bool)
    {
        return _config.router == bytes32(0);
    }

    /**
     * @notice Returns the salt used to deploy the interchain account for a given `origin`/`owner` pair.
     * @param _origin The origin domain of the interchain account.
     * @param _owner The parent account address on the origin domain.
     * @return The CREATE2 salt used for deploying the interchain account.
     */
    function _salt(
        uint32 _origin,
        bytes32 _owner,
        address _ism
    ) private pure returns (bytes32) {
        return bytes32(abi.encodePacked(_origin, _owner, _ism));
    }

    /**
     * @notice Returns the address of the interchain account.
     * @dev Can only be used to compute interchain account addresses for
     * EVM chains.
     * @return The address of the interchain account.
     */
    function _getInterchainAccount(bytes32 salt)
        private
        view
        returns (address payable)
    {
        return payable(Create2.computeAddress(salt, bytecodeHash));
    }
}
