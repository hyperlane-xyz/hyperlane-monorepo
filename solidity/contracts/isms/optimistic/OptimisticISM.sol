// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {console2} from "forge-std/console2.sol";
// ============ Internal Imports ============
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

// import {StaticMOfNAddressSetFactory} from "../../libs/StaticMOfNAddressSetFactory.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";


contract OptimisticISM is Ownable, IOptimisticIsm {

    struct MessageCheck {
        uint64 timestamp;
        address checkingSubmodule;
    }

    /// @inheritdoc IInterchainSecurityModule
    uint8 public constant override moduleType = uint8(Types.OPTIMISTIC);

    /// @notice The number of seconds after which a message is considered non-fraudulent
    uint64 public fraudWindow;

    /// @notice The current submodule responsible for verifying messages
    IInterchainSecurityModule internal _submodule;

    /// @notice The set of watchers responsible for marking submodules as fraudulent
    address[] public watchers;
    
    /// @notice The number of watchers that must mark a submodule as fraudulent
    uint256 public threshold;

    /// @notice The set of submodules that have been marked as fraudulent
    mapping(address => address[]) public fraudulantSubmodules;

    /// @notice The set of messages that have been pre-verified
    mapping(bytes32 => MessageCheck) public messages;

    /// @notice ensures only watchers can call a function
    modifier onlyWatchers() {
        bool isWatcher = false;
        for (uint256 i = 0; i < watchers.length; i++) {
            if (watchers[i] == msg.sender) {
                isWatcher = true;
                break;
            }
        }
        if(!isWatcher) {
            revert OnlyWatcherError();
        }
        _;
    }

    constructor(IInterchainSecurityModule initSubmodule, uint64 _fraudWindow, uint256 _threshold, address[] memory _watchers)
        Ownable()
    {
        _setSubmodule(initSubmodule);
        _setFraudWindow(_fraudWindow);
        _addWatchers(_watchers);
        _setThreshold(_threshold);
    }

    // ============ EXTERNAL ============

    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        // load current checking submodule
        IInterchainSecurityModule checkingSubmodule = _submodule;

        bool isVerified = checkingSubmodule.verify(_metadata, _message);
        if (!isVerified) {
            return false;
        }
        messages[keccak256(abi.encode(_metadata, _message))] = MessageCheck({
            timestamp: uint64(block.timestamp) + fraudWindow,
            checkingSubmodule: address(checkingSubmodule)
        });
        return true;
    }

    /**
     * @inheritdoc IInterchainSecurityModule
     * @dev
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        view
        returns (bool)
    {
        // load message
        MessageCheck memory message = messages[
            keccak256(abi.encode(_metadata, _message))
        ];

        // The message has been pre-verified
        if (message.timestamp == 0) {
            console2.log("message not pre-verified");
            return false;
        }

        // The submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchers
        if (_isFraudulentSubmodule(message.checkingSubmodule)) {
            console2.log("fraudulent submodule");
            return false;
        }

        console2.log("message timestamp ", message.timestamp);
        // The fraud window has elapsed
        if (uint64(block.timestamp) < message.timestamp) {
            console2.log("fraud window not passed");
            return false;
        }

        return true;
    }

    function submodule(bytes calldata _message)
        external
        view
        returns (IInterchainSecurityModule)
    {
        return _submodule;
    }

    function getMessage(bytes32 id)
        external
        view
        returns (MessageCheck memory)
    {
        return messages[id];
    }

    // ============ AUTHORIZED ============

    function addWatchers(address[] calldata _watchers) external onlyOwner {
        _addWatchers(_watchers);
    }

    function setThreshold(uint256 _threshold) external onlyOwner {
        _setThreshold(_threshold);
    }

    function markFraudulent(IInterchainSecurityModule _submodule) external onlyWatchers {
        fraudulantSubmodules[address(_submodule)].push(msg.sender);
        emit FraudulentISM(_submodule, msg.sender);
    }

    function setSubmodule(IInterchainSecurityModule newSubmodule)
        external
        onlyOwner
    {
        //todo: do we need a check to see if the submodule is within a list of submoduiels?

        _setSubmodule(newSubmodule);
    }

    // ============ INTERNAL ============

    function _addWatchers(address[] memory _watchers) internal {
        for (uint256 i = 0; i < _watchers.length; i++) {
            watchers.push(_watchers[i]);
            emit WatcherAdded(_watchers[i]);
        }
    }

    function _setSubmodule(IInterchainSecurityModule newSubmodule) internal {
        _submodule = IInterchainSecurityModule(newSubmodule);
        emit SetSubmodule(newSubmodule);
    }

    function _setFraudWindow(uint64 _fraudWindow) internal {
        fraudWindow = _fraudWindow;
        emit SetFraudWindow(_fraudWindow);
    }

    function _setThreshold(uint256 _threshold) internal {
        
        if(_threshold > watchers.length){
            revert ThresholdTooLarge();
        }

        threshold = _threshold;
        emit ThresholdSet(_threshold);
    }

    function _isFraudulentSubmodule(address module)
        internal
        view
        returns (bool)
    {
        // iterate thru submodules and see how many watchers say the submodule is fraudulent
        uint256 count = fraudulantSubmodules[module].length;
        if(count >= threshold){
            return true;
        }
        return false;
    }
}
