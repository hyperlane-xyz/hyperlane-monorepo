// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma experimental ABIEncoderV2;

// ============ Internal Imports ============
import {GovernanceMessage} from "./GovernanceMessage.sol";
// ============ External Imports ============
import {Version0} from "@abacus-network/abacus-sol/contracts/Version0.sol";
import {Router} from "@abacus-network/abacus-sol/contracts/router/Router.sol";
import {TypeCasts} from "@abacus-network/abacus-sol/contracts/XAppConnectionManager.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/Initializable.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @dev GovernanceRouter has two modes of operation, normal and recovery.
 * During normal mode, `owner()` returns the `governor`, giving it permission
 * to call `onlyOwner` functions.
 * During recovery mode, `owner()` returns the `_owner`, giving it permission
 * to call `onlyOwner` functions.
 */
contract GovernanceRouter is Version0, Router {
    // ============ Libraries ============

    using SafeMath for uint256;
    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using GovernanceMessage for bytes29;

    // ============ Immutables ============

    // number of seconds before recovery can be activated
    uint256 public immutable recoveryTimelock;

    // ============ Public Storage ============

    // timestamp when recovery timelock expires; 0 if timelock has not been initiated
    uint256 public recoveryActiveAt;
    // the local entity empowered to call governance functions during normal
    // operation, typically set to 0x0 on all chains but one
    address public governor;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[48] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when the Governor role is set
     * @param governor the address of the new Governor
     */
    event SetGovernor(address indexed governor);

    /**
     * @notice Emitted when recovery state is initiated by the Owner
     * @param owner the address of the current owner who initiated the transition
     * @param recoveryActiveAt the block at which recovery state will be active
     */
    event InitiateRecovery(address indexed owner, uint256 recoveryActiveAt);

    /**
     * @notice Emitted when recovery state is exited by the Owner
     * @param owner the address of the current Owner who initiated the transition
     */
    event ExitRecovery(address owner);

    // ============ Modifiers ============

    modifier typeAssert(bytes29 _view, GovernanceMessage.Types _type) {
        _view.assertType(uint40(_type));
        _;
    }

    modifier onlyInRecovery() {
        require(inRecovery(), "!recovery");
        _;
    }

    modifier onlyNotInRecovery() {
        require(!inRecovery(), "recovery");
        _;
    }

    modifier onlyGovernor() {
        require(msg.sender == governor, "!governor");
        _;
    }

    modifier onlyRecoveryManager() {
        require(msg.sender == recoveryManager(), "!recoveryManager");
        _;
    }

    // ============ Constructor ============

    constructor(uint256 _recoveryTimelock) {
        recoveryTimelock = _recoveryTimelock;
    }

    // ============ Initializer ============

    function initialize(address _xAppConnectionManager) public initializer {
        __XAppConnectionClient_initialize(_xAppConnectionManager);
        governor = msg.sender;
    }

    // ============ External Functions ============

    /**
     * @notice Handle Abacus messages
     * For all non-Governor chains to handle messages
     * sent from the Governor chain via Abacus.
     * Governor chain should never receive messages,
     * because non-Governor chains are not able to send them
     * @param _origin The domain (of the Governor Router)
     * @param _sender The message sender (must be the Governor Router)
     * @param _message The message
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes memory _message
    ) external override onlyInbox onlyRemoteRouter(_origin, _sender) {
        bytes29 _msg = _message.ref(0);
        if (_msg.isValidCall()) {
            _handleCall(_msg.tryAsCall());
        } else if (_msg.isValidSetGovernor()) {
            _handleSetGovernor(_msg.tryAsSetGovernor());
        } else if (_msg.isValidEnrollRemoteRouter()) {
            _handleEnrollRemoteRouter(_msg.tryAsEnrollRemoteRouter());
        } else if (_msg.isValidSetXAppConnectionManager()) {
            _handleSetXAppConnectionManager(
                _msg.tryAsSetXAppConnectionManager()
            );
        } else {
            require(false, "!valid message type");
        }
    }

    // ============ External Local Functions ============

    /**
     * @notice Make local calls.
     * @param _calls The calls
     */
    function call(GovernanceMessage.Call[] calldata _calls) external onlyOwner {
        for (uint256 i = 0; i < _calls.length; i++) {
            _makeCall(_calls[i]);
        }
    }

    /**
     * @notice Sets the governor of the router.
     * @param _governor The address of the new governor
     */
    function setGovernor(address _governor) external onlyOwner {
        _setGovernor(_governor);
    }

    /**
     * @notice Initiate the recovery timelock
     * @dev callable by the recovery manager iff not in recovery
     */
    function initiateRecoveryTimelock()
        external
        onlyNotInRecovery
        onlyRecoveryManager
    {
        require(recoveryActiveAt == 0, "recovery already initiated");
        // set the time that recovery will be active
        recoveryActiveAt = block.timestamp.add(recoveryTimelock);
        emit InitiateRecovery(recoveryManager(), recoveryActiveAt);
    }

    /**
     * @notice Exit recovery mode
     * @dev callable by the recovery manager iff in recovery
     */
    function exitRecovery() external onlyInRecovery onlyRecoveryManager {
        delete recoveryActiveAt;
        emit ExitRecovery(recoveryManager());
    }

    // ============ External Remote Functions ============

    /**
     * @notice Dispatch calls on a remote chain via the remote GovernanceRouter
     * @param _destination The domain of the remote chain
     * @param _calls The calls
     */
    function callRemote(
        uint32 _destination,
        GovernanceMessage.Call[] calldata _calls
    ) external onlyGovernor onlyNotInRecovery {
        bytes memory _msg = GovernanceMessage.formatCalls(_calls);
        _dispatchToRemoteRouter(_destination, _msg);
    }

    /**
     * @notice Enroll a remote router on a remote router.
     * @param _destination The domain of the enroller
     * @param _domain The domain of the enrollee
     * @param _router The address of the enrollee
     */
    function enrollRemoteRouterRemote(
        uint32 _destination,
        uint32 _domain,
        bytes32 _router
    ) external onlyGovernor onlyNotInRecovery {
        bytes memory _msg = GovernanceMessage.formatEnrollRemoteRouter(
            _domain,
            _router
        );
        _dispatchToRemoteRouter(_destination, _msg);
    }

    /**
     * @notice Sets the xAppConnectionManager of a remote router.
     * @param _destination The domain of router on which to set the xAppConnectionManager
     * @param _xAppConnectionManager The address of the xAppConnectionManager contract
     */
    function setXAppConnectionManagerRemote(
        uint32 _destination,
        address _xAppConnectionManager
    ) external onlyGovernor onlyNotInRecovery {
        bytes memory _msg = GovernanceMessage.formatSetXAppConnectionManager(
            TypeCasts.addressToBytes32(_xAppConnectionManager)
        );
        _dispatchToRemoteRouter(_destination, _msg);
    }

    /**
     * @notice Sets the governor of a remote router.
     * @param _destination The domain of router on which to set the governor
     * @param _governor The address of the new governor
     */
    function setGovernorRemote(uint32 _destination, address _governor)
        external
        onlyGovernor
        onlyNotInRecovery
    {
        bytes memory _msg = GovernanceMessage.formatSetGovernor(
            TypeCasts.addressToBytes32(_governor)
        );
        _dispatchToRemoteRouter(_destination, _msg);
    }

    // ============ Public Functions ============

    /**
     * @notice Transfers the recovery manager to a new address.
     * @dev Callable by the governor when not in recovery mode or the
     * recoveryManager at any time.
     * @param _recoveryManager The address of the new recovery manager
     */
    function transferOwnership(address _recoveryManager)
        public
        virtual
        override
    {
        // If we are not in recovery, temporarily enter recovery so that the
        // recoveryManager can call transferOwnership.
        if (msg.sender == recoveryManager() && !inRecovery()) {
            uint256 _recoveryActiveAt = recoveryActiveAt;
            recoveryActiveAt = 1;
            OwnableUpgradeable.transferOwnership(_recoveryManager);
            recoveryActiveAt = _recoveryActiveAt;
        } else {
            OwnableUpgradeable.transferOwnership(_recoveryManager);
        }
    }

    /**
     * @notice Returns the address of the current owner.
     * @dev When not in recovery mode, the governor owns the contract.
     */
    function owner() public view virtual override returns (address) {
        return inRecovery() ? recoveryManager() : governor;
    }

    /**
     * @notice Returns the address of the recovery manager.
     * @dev Exposing via this funciton is necessary because we overload
     * `owner()` in order to make `onlyOwner()` work as intended, and because
     * `OwnableUpgradeable` does not expose the private `_owner`.
     */
    function recoveryManager() public view returns (address) {
        return OwnableUpgradeable.owner();
    }

    /**
     * @notice Check if the contract is in recovery mode currently
     * @return TRUE iff the contract is actively in recovery mode currently
     */
    function inRecovery() public view returns (bool) {
        uint256 _recoveryActiveAt = recoveryActiveAt;
        bool _recoveryInitiated = _recoveryActiveAt != 0;
        bool _recoveryActive = _recoveryActiveAt <= block.timestamp;
        return _recoveryInitiated && _recoveryActive;
    }

    // ============ Internal Functions ============

    /**
     * @notice Handle message dispatching calls locally
     * @param _msg The message
     */
    function _handleCall(bytes29 _msg)
        internal
        typeAssert(_msg, GovernanceMessage.Types.Call)
    {
        GovernanceMessage.Call[] memory _calls = _msg.getCalls();
        for (uint256 i = 0; i < _calls.length; i++) {
            _makeCall(_calls[i]);
        }
    }

    /**
     * @notice Handle message transferring governorship to a new Governor
     * @param _msg The message
     */
    function _handleSetGovernor(bytes29 _msg)
        internal
        typeAssert(_msg, GovernanceMessage.Types.SetGovernor)
    {
        address _governor = TypeCasts.bytes32ToAddress(_msg.governor());
        _setGovernor(_governor);
    }

    /**
     * @notice Handle message setting the router address for a given domain
     * @param _msg The message
     */
    function _handleEnrollRemoteRouter(bytes29 _msg)
        internal
        typeAssert(_msg, GovernanceMessage.Types.EnrollRemoteRouter)
    {
        uint32 _domain = _msg.domain();
        bytes32 _router = _msg.router();
        _enrollRemoteRouter(_domain, _router);
    }

    /**
     * @notice Handle message setting the xAppConnectionManager address
     * @param _msg The message
     */
    function _handleSetXAppConnectionManager(bytes29 _msg)
        internal
        typeAssert(_msg, GovernanceMessage.Types.SetXAppConnectionManager)
    {
        address _xAppConnectionManager = TypeCasts.bytes32ToAddress(
            _msg.xAppConnectionManager()
        );
        _setXAppConnectionManager(_xAppConnectionManager);
    }

    /**
     * @notice Call local contract.
     * @param _call The call
     * @return _ret
     */
    function _makeCall(GovernanceMessage.Call memory _call)
        internal
        returns (bytes memory _ret)
    {
        address _to = TypeCasts.bytes32ToAddress(_call.to);
        // attempt to dispatch using low-level call
        bool _success;
        (_success, _ret) = _to.call(_call.data);
        // revert if the call failed
        require(_success, "call failed");
    }

    /**
     * @notice Set the governor.
     * @param _governor The address of the new governor
     */
    function _setGovernor(address _governor) internal {
        governor = _governor;
        emit SetGovernor(_governor);
    }
}
