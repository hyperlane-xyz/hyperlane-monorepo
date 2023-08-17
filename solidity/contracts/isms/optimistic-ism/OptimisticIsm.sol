// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

// ============ Internal Imports ============
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

// ============ CONTRACT ============
abstract contract OptimisticIsm is IOptimisticIsm, OwnableUpgradeable {
   // ============ Events ============
    event RelayerCalledMessagePreVerify(address indexed _relayer);
    event MessageDelivered(bytes indexed _message);
    event SubmoduleChanged(IInterchainSecurityModule _module);
    event FraudWindowOpened(IInterchainSecurityModule _module);
    event SubmoduleMarkedFraudulent(IInterchainSecurityModule _module);

  // ============ Core Variables ============
    mapping(address => bool) public watchers; //watchers added by owner
    mapping(address => bool) public relayers; //relayers who have sent messages pending between preVerify() and deliver()
    mapping(uint32 => IInterchainSecurityModule) public module; //domain to submodule mapping
    mapping(address => bytes) private _relayerToMessages; //relayer to message mapping

  // ============ Fraud Variables ============
    uint256 public fraudWindow; //fraud window duration as defined by owner in deployment OR after via changeFraudWindow()
    mapping(bytes => uint256) public fraudWindows; //message to uint (time duration) to be initiated by initiateFraudWindow()
    mapping(IInterchainSecurityModule => bool) public subModuleFlags; //markFraudulent() manipulates this

  // ============ Custom Errors ============
    error NotWatcher(address attemptedAccess);

  // ============ Modifiers ============
    modifier onlyWatcher(address _inquisitor) {
        if (!watchers[_inquisitor]) {
            revert NotWatcher(msg.sender);
        }
        _;
    }

  // ============ Constructor ============
    constructor(
        uint32 _domain,
        IInterchainSecurityModule _module,
        uint256 _fraudWindow
    ) {
        _set(_domain, _module);
        fraudWindow = _fraudWindow;
    }

  // ============ Internal/Private Functions ============

    /**
     * @notice sets ISM to be used in message verification
     * @param _domain origin domain of the ISM
     * @param _module ISM module to use for verification
     */
    function _set(uint32 _domain, IInterchainSecurityModule _module) internal {
        require(Address.isContract(address(_module)), "!contract");
        module[_domain] = _module;
    }

    /**
     * @notice opens a fraud window in which watchers can mark submodules as fraudulent
     */
    function _initiateFraudWindow(bytes calldata _message) internal {
        fraudWindows[_message] = block.timestamp + fraudWindow;
    }

    /**
     * @notice checks to see if the fraud window is still open
     * @param _message formatted Hyperlane message (see Message.sol) mapped to fraud window
     */
    function _checkFraudWindow(bytes calldata _message)
        internal
        returns (bool)
    {
        if (block.timestamp > fraudWindows[_message]) {
            return true;
        } else {
            return false;
        }
    }

    /**
     * @notice allows owner to modify current fraud window duration
     * @param _newFraudWindow time duration of new fraud window
     */
    function _changeFraudWindow(uint256 _newFraudWindow) external onlyOwner {
        fraudWindow = _newFraudWindow;
    }


