// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma experimental ABIEncoderV2;

// ============ Internal Imports ============
import {ControllerMessage} from "./ControllerMessage.sol";
// ============ External Imports ============
import {Router} from "@abacus-network/app/contracts/Router.sol";
import {Version0} from "@abacus-network/core/contracts/Version0.sol";
import {TypeCasts} from "@abacus-network/core/libs/TypeCasts.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/Initializable.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @dev ControllerRouter has two modes of operation, normal and recovery.
 * During normal mode, `owner()` returns the `controller`, giving it permission
 * to call `onlyOwner` functions.
 * During recovery mode, `owner()` returns the `_owner`, giving it permission
 * to call `onlyOwner` functions.
 */
contract ControllerRouter is Version0, Router {
    // ============ Libraries ============

    using SafeMath for uint256;
    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using ControllerMessage for bytes29;

    // ============ Immutables ============

    // number of seconds before recovery can be activated
    uint256 public immutable recoveryTimelock;

    // ============ Public Storage ============

    // timestamp when recovery timelock expires; 0 if timelock has not been initiated
    uint256 public recoveryActiveAt;
    // the local entity empowered to call permissioned functions during normal
    // operation, typically set to 0x0 on all chains but one
    address public controller;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[48] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when the controller role is set
     * @param controller the address of the new controller
     */
    event SetController(address indexed controller);

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

    modifier typeAssert(bytes29 _view, ControllerMessage.Types _type) {
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

    modifier onlyController() {
        require(msg.sender == controller, "!controller");
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

    function initialize(address _abacusConnectionManager) public initializer {
        __Router_initialize(_abacusConnectionManager);
        controller = msg.sender;
    }

    // ============ External Functions ============

    /**
     * @notice Handle Abacus messages
     * For all non-controlling chains to handle messages
     * sent from the controlling chain via Abacus.
     * Controlling chain should never receive messages,
     * because non-controlling chains are not able to send them
     * @param _message The message
     */
    function _handle(
        uint32,
        bytes32,
        bytes memory _message
    ) internal override {
        bytes29 _msg = _message.ref(0);
        if (_msg.isValidCall()) {
            _handleCall(_msg.tryAsCall());
        } else if (_msg.isValidSetController()) {
            _handleSetController(_msg.tryAsSetController());
        } else if (_msg.isValidEnrollRemoteRouter()) {
            _handleEnrollRemoteRouter(_msg.tryAsEnrollRemoteRouter());
        } else if (_msg.isValidSetAbacusConnectionManager()) {
            _handleSetAbacusConnectionManager(
                _msg.tryAsSetAbacusConnectionManager()
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
    function call(ControllerMessage.Call[] calldata _calls) external onlyOwner {
        for (uint256 i = 0; i < _calls.length; i++) {
            _makeCall(_calls[i]);
        }
    }

    /**
     * @notice Sets the controller of the router.
     * @param _controller The address of the new controller
     */
    function setController(address _controller) external onlyOwner {
        _setController(_controller);
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
     * @notice Dispatch calls on a remote chain via the remote ControllerRouter.
     * Any value paid to this function is used to pay for message processing on the remote chain.
     * @param _destination The domain of the remote chain
     * @param _calls The calls
     */
    function callRemote(
        uint32 _destination,
        ControllerMessage.Call[] calldata _calls
    ) external payable onlyController onlyNotInRecovery {
        bytes memory _msg = ControllerMessage.formatCalls(_calls);
        _dispatchWithGasAndCheckpoint(_destination, _msg, msg.value);
    }

    /**
     * @notice Enroll a remote router on a remote router. Any value paid to this
     * function is used to pay for message processing on the remote chain.
     * @param _destination The domain of the enroller
     * @param _domain The domain of the enrollee
     * @param _router The address of the enrollee
     */
    function enrollRemoteRouterRemote(
        uint32 _destination,
        uint32 _domain,
        bytes32 _router
    ) external payable onlyController onlyNotInRecovery {
        bytes memory _msg = ControllerMessage.formatEnrollRemoteRouter(
            _domain,
            _router
        );
        _dispatchWithGasAndCheckpoint(_destination, _msg, msg.value);
    }

    /**
     * @notice Sets the abacusConnectionManager of a remote router. Any value paid to this
     * function is used to pay for message processing on the remote chain.
     * @param _destination The domain of router on which to set the abacusConnectionManager
     * @param _abacusConnectionManager The address of the abacusConnectionManager contract
     */
    function setAbacusConnectionManagerRemote(
        uint32 _destination,
        address _abacusConnectionManager
    ) external payable onlyController onlyNotInRecovery {
        bytes memory _msg = ControllerMessage.formatSetAbacusConnectionManager(
            TypeCasts.addressToBytes32(_abacusConnectionManager)
        );
        _dispatchWithGasAndCheckpoint(_destination, _msg, msg.value);
    }

    /**
     * @notice Sets the controller of a remote router. Any value paid to this
     * function is used to pay for message processing on the remote chain.
     * @param _destination The domain of router on which to set the controller
     * @param _controller The address of the new controller
     */
    function setControllerRemote(uint32 _destination, address _controller)
        external
        payable
        onlyController
        onlyNotInRecovery
    {
        bytes memory _msg = ControllerMessage.formatSetController(
            TypeCasts.addressToBytes32(_controller)
        );
        _dispatchWithGasAndCheckpoint(_destination, _msg, msg.value);
    }

    // ============ Public Functions ============

    /**
     * @notice Transfers the recovery manager to a new address.
     * @dev Callable by the controller when not in recovery mode or the
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
     * @dev When not in recovery mode, the controller owns the contract.
     */
    function owner() public view virtual override returns (address) {
        return inRecovery() ? recoveryManager() : controller;
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
        typeAssert(_msg, ControllerMessage.Types.Call)
    {
        ControllerMessage.Call[] memory _calls = _msg.getCalls();
        for (uint256 i = 0; i < _calls.length; i++) {
            _makeCall(_calls[i]);
        }
    }

    /**
     * @notice Handle message transferring control to a new Controller
     * @param _msg The message
     */
    function _handleSetController(bytes29 _msg)
        internal
        typeAssert(_msg, ControllerMessage.Types.SetController)
    {
        address _controller = TypeCasts.bytes32ToAddress(_msg.controller());
        _setController(_controller);
    }

    /**
     * @notice Handle message setting the router address for a given domain
     * @param _msg The message
     */
    function _handleEnrollRemoteRouter(bytes29 _msg)
        internal
        typeAssert(_msg, ControllerMessage.Types.EnrollRemoteRouter)
    {
        uint32 _domain = _msg.domain();
        bytes32 _router = _msg.router();
        _enrollRemoteRouter(_domain, _router);
    }

    /**
     * @notice Handle message setting the abacusConnectionManager address
     * @param _msg The message
     */
    function _handleSetAbacusConnectionManager(bytes29 _msg)
        internal
        typeAssert(_msg, ControllerMessage.Types.SetAbacusConnectionManager)
    {
        address _abacusConnectionManager = TypeCasts.bytes32ToAddress(
            _msg.abacusConnectionManager()
        );
        _setAbacusConnectionManager(_abacusConnectionManager);
    }

    /**
     * @notice Call local contract.
     * @param _call The call
     * @return _ret
     */
    function _makeCall(ControllerMessage.Call memory _call)
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
     * @notice Set the controller.
     * @param _controller The address of the new controller
     */
    function _setController(address _controller) internal {
        controller = _controller;
        emit SetController(_controller);
    }
}
