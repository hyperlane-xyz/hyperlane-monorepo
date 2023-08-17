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

  // ============ External/Public Functions ============
    /**
     * @notice checks to see if:
     * 1	The message has been pre-verified
     * 2	The submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchers
     * 3	The fraud window has elapsed
     */
    function preVerifiedCheck(bytes calldata _metadata, bytes calldata _message)
        public
        returns (bool)
    {
        IInterchainSecurityModule currentModule = submodule(_message);
        if (
            relayers[msg.sender] &&
            !subModuleFlags[currentModule] &&
            _checkFraudWindow(_message)
        ) {
            return true;
        }
    }

    /**
     * @notice allows owner to modify ISM being used for message verification
     * @param _domain origin domain of the ISM
     * @param _module alternative ISM module to be used
     */
    function setIsm(uint32 _domain, IInterchainSecurityModule _module)
        external
        onlyOwner
    {
        _set(_domain, _module);
        emit SubmoduleChanged(_module);
    }

    /**
     * @notice returns the ISM responsible for verifying _message
     * @dev changes based on the content of _message
     * @param _message formatted Hyperlane message (see Message.sol).
     * @return module ISM being used to verify _message
     */
    function submodule(bytes calldata _message)
        public
        view
        override
        returns (IInterchainSecurityModule)
    {
        IInterchainSecurityModule module = module[Message.origin(_message)];
        require(
            address(module) != address(0),
            "No ISM found for origin domain"
        );
        return module;
    }

    /**
     * @notice allows watchers added by owner to flag ISM submodule(s) as fraudulent
     * @param _message formatted Hyperlane message (see Message.sol).
     */
    function markFraudulent(bytes calldata _message)
        external
        onlyWatcher(msg.sender)
    {
        IInterchainSecurityModule thisModule = submodule(_message);
        subModuleFlags[thisModule] = true;
        emit SubmoduleMarkedFraudulent(thisModule);
    }

    /**
     * @notice allows owner to add watchers to watchers mapping
     * @param _watchersArray array of watcher addresses
     */
    function addWatchers(address[] calldata _watchersArray) external onlyOwner {
        uint8 i;
        for (i = 0; i < _watchersArray.length; i++) {
            watchers[_watchersArray[i]] = true;
        }
    }

    /**
     * @notice allows owner to mark watchers as redunant in watchers mapping
     * @param _watcherToBeRemoved address of watcher to be made redunant
     */
    function removeWatcher(address _watcherToBeRemoved) external onlyOwner {
        watchers[_watcherToBeRemoved] = false;
    }

  // ============ Core Functionality ============
    /**
     * @notice pre verifies messages recieved by a relayer,
     *         adding their addresses to the relayers mapping,
     *         initiating a fraudWindow, mapping the message to this fraudWindow and
     *         mapping the message sent to the submodule used to verify the message
     * @param  _metadata arbitrary bytes that can be specified by an off-chain relayer
     * @param  _message formatted Hyperlane message (see Message.sol).
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        public
        override
        returns (bool)
    {
        require(_relayerToMessages[msg.sender], "you are only allowed to send one message at a time");
        bool isVerified = verify(_metadata, _message);
        if (isVerified) {
            _relayerToMessages[msg.sender] = _message;
            _initiateFraudWindow(_message);
            IInterchainSecurityModule currentModule = submodule(_message);
            emit FraudWindowOpened(currentModule);
            emit RelayerCalledMessagePreVerify(msg.sender);
            return true;
        }
    }

    /**
     * @notice calls preVerifiedCheck() to ensure the submodule has not been flagged as fraudulent
     *         and, if preVerifiedCheck() returns true, delivers the message to recipient address
     * @param  _destination destination for message sent by relayer (msg.sender)
     */
    function deliver(
        address _destination,
        bytes calldata _metadata,
        bytes calldata _message
    ) public {
        bool messagePassesChecks = preVerifiedCheck(_metadata, _message);
        if (messagePassesChecks) {
            _destination.call(_message);
            emit MessageDelivered(_message);
        }
    }
}
