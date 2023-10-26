// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// ============ Internal Imports ============
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {StaticOptimisticWatchersFactory} from "./StaticOptimisticWatchersFactory.sol";
import {StaticOptimisticWatchers} from "./StaticOptimisticWatchers.sol";
import {Message} from "../../libs/Message.sol";

/// @notice An OptimisticISM is an ISM that uses a set of watchers to mark submodules as fraudulent.
/// If a message is verified by a submodule that is marked as fraudulent within a fraud window,
/// the message is considered fraudulent, otherwise it is considered valid and can be delivered.
contract OptimisticISM is Ownable, Initializable, StaticOptimisticWatchersFactory, IOptimisticIsm {
    using Message for bytes;

    struct MessageCheck {
        uint64 timestamp;
        address checkingSubmodule;
    }

    /// @inheritdoc IInterchainSecurityModule
    uint8 public constant override moduleType = uint8(Types.OPTIMISTIC);

    /// @notice The number of seconds after which a message is considered non-fraudulent (expired window)
    uint64 public fraudWindow;

    /// @notice The current submodule responsible for verifying messages
    IInterchainSecurityModule internal _submodule;

    /// @notice The set of submodules that have been marked as fraudulent
    mapping(address => address[]) public fraudulantSubmodules;

    /// @notice The set of messages that have been pre-verified
    mapping(bytes32 => MessageCheck) public messages;

    /// @notice The set of watchers responsible for marking submodules as fraudulent
    address public currentWatchers;

    /// @notice ensures only watchers can call a function
    modifier onlyWatchers() {
        bool isWatcher = false;
        (address[] memory watchers, uint8 m) = StaticOptimisticWatchers(currentWatchers).watchersAndThreshold(bytes(""));
        for (uint256 i = 0; i < watchers.length; i++) {
            if (watchers[i] == msg.sender) {
                isWatcher = true;
                break;
            }
        }
        if(!isWatcher) {
            revert OnlyWatcher();
        }
        _;
    }

    // ============ CONSTRUCTOR ============

    constructor(IInterchainSecurityModule initSubmodule, uint64 _fraudWindow, address _currentWatchers)
        Ownable()
    {
        _setSubmodule(initSubmodule);
        _setFraudWindow(_fraudWindow);
        currentWatchers = _currentWatchers;
    }

    // ============ EXTERNAL ============
    
    /**
     * @inheritdoc IOptimisticIsm
     * @dev Called as part of message delivery
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        IInterchainSecurityModule checkingSubmodule = _submodule;
        if (!checkingSubmodule.verify(_metadata, _message)) {
            return false;
        }
        messages[_message.id()] = MessageCheck({
            timestamp: uint64(block.timestamp),
            checkingSubmodule: address(checkingSubmodule)
        });
        emit PreVerified(_message.id());
        return true;
    }

    /**
     * @inheritdoc IInterchainSecurityModule
     * @dev Called as part of message delivery
     */
    function verify(bytes calldata, bytes calldata _message)
        external
        view
        returns (bool)
    {           
        MessageCheck memory message = messages[_message.id()];

        if(message.timestamp == 0 ||  _isFraudWindowExpired(message.timestamp) || _isFraudulentSubmodule(message.checkingSubmodule)){
            return false;
        }
        return true;
    }

    /// @inheritdoc IOptimisticIsm
    function submodule(bytes calldata)
        external
        view
        returns (IInterchainSecurityModule)
    {
        return _submodule;
    }

    /// @notice Getter for messages passing thru this OptimisticISM
    /// @param id The id of the message (Message.id())
    function getMessage(bytes32 id)
        external
        view
        returns (MessageCheck memory)
    {
        return messages[id];
    }

    // ============ AUTHORIZED ============

    /**
     * @inheritdoc IOptimisticIsm
     * @dev only callable by watchers only per submodule
     */
    function markFraudulent(IInterchainSecurityModule _fraudulantSubmodule) external onlyWatchers {
        // check watcher hasn't already flagged submodule as fraudulent
        uint256 currentFradulantCount = fraudulantSubmodules[address(_fraudulantSubmodule)].length;
        for(uint256 i = 0; i < currentFradulantCount; i++) {
            if (fraudulantSubmodules[address(_submodule)][i] == msg.sender) {
                revert AlreadyMarkedFraudulent();
            }
        }

        fraudulantSubmodules[address(_submodule)].push(msg.sender);
        emit FraudulentISM(_submodule, msg.sender);
    }

    /// @notice Sets the current fraud window
    /// @dev all existing messages are checked against the new fraud window
    /// @param _fraudWindow The fraud window to set
    function setFraudWindow(uint64 _fraudWindow) external onlyOwner {
        _setFraudWindow(_fraudWindow);
    }
    
    /// @notice Sets the current verifying submodule
    /// @param newSubmodule The submodule to set as the current submodule
    function setSubmodule(IInterchainSecurityModule newSubmodule)
        external
        onlyOwner
    {
        if(newSubmodule.moduleType() != uint8(Types.OPTIMISTIC)){
            revert InvalidSubmodule();
        }

        _setSubmodule(newSubmodule);
    }

    /// @notice convenience function to check if a message is outside the fraud window
    /// @param id The id of the message (Message id())
    function messageFraudWindowExpired(bytes32 id) external view returns (bool){
        return _isFraudWindowExpired(messages[id].timestamp);
    }

    // ============ INTERNAL ============
    
    /// @notice returns true if the timestamp passed is outside the fraud window, i.e. optimistically safe
    function _isFraudWindowExpired(uint64 messageTimestamp) internal view returns (bool){
        return messageTimestamp + fraudWindow  > uint64(block.timestamp);
    }

    function _setSubmodule(IInterchainSecurityModule newSubmodule) internal {
        _submodule = IInterchainSecurityModule(newSubmodule);
        emit SetSubmodule(newSubmodule);
    }

    function _setFraudWindow(uint64 _fraudWindow) internal {
        fraudWindow = _fraudWindow;
        emit SetFraudWindow(_fraudWindow);
    }

    function _isFraudulentSubmodule(address module)
        internal
        view
        returns (bool)
    {
        (, uint8 m) = StaticOptimisticWatchers(currentWatchers).watchersAndThreshold(bytes(""));
        uint256 count = fraudulantSubmodules[module].length;
        if(count >= m){
            return true;
        }
        return false;
    }
}
