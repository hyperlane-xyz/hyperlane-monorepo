// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {console2} from "forge-std/console2.sol";
// ============ Internal Imports ============
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {StaticOptimisticWatchersFactory} from "./StaticOptimisticWatchersFactory.sol";
import {StaticOptimisticWatchers} from "./StaticOptimisticWatchers.sol";

// import {StaticMOfNAddressSetFactory} from "../../libs/StaticMOfNAddressSetFactory.sol";
// import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";


contract OptimisticISM is Ownable, Initializable, StaticOptimisticWatchersFactory, IOptimisticIsm {

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

    /// @notice The number of watchers that must mark a submodule as fraudulent
    uint256 public threshold;

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
            revert OnlyWatcherError();
        }
        _;
    }

    constructor(IInterchainSecurityModule initSubmodule, uint64 _fraudWindow)
        Ownable()
    {
        _setSubmodule(initSubmodule);
        _setFraudWindow(_fraudWindow);
    }

    // ============ EXTERNAL ============

    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        // load current checking submodule
        IInterchainSecurityModule checkingSubmodule = _submodule;
        if (!checkingSubmodule.verify(_metadata, _message)) {
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
     * @dev Called as part of message delivery
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        view
        returns (bool)
    {   
        bytes32 txId = keccak256(abi.encode(_metadata, _message));
        MessageCheck memory message = messages[txId];

        if(message.timestamp == 0 || uint64(block.timestamp) < message.timestamp || _isFraudulentSubmodule(message.checkingSubmodule)){
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
    /// @notice Initializes the OptimisticISM with a set of watchers
    function initialize(address[] memory _watchers, uint8 _threshold) external initializer onlyOwner{
        currentWatchers = _newStaticMofN(_watchers, _threshold);
    }

    /// @notice Creates a new static M-of-N watcher set
    function setNewStaticNofMWatchers(address[] memory watchers, uint8 m) external onlyOwner {
        currentWatchers = _newStaticMofN(watchers, m);
    }
    
    /// @notice Marks a submodule as fraudulent
    /// @dev only callable by watchers only per submodule
    /// @param _fraudulantSubmodule The submodule to mark as fraudulent
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

    // ============ INTERNAL ============

    function _newStaticMofN(address[] memory _watchers, uint8 _threshold) internal returns (address){
        if(_threshold == 0){
            revert NonZeroThreshold();
        }
        if(_watchers.length < _threshold){
            revert ThresholdTooLarge();
        }
        address newWatchers = this.deploy(_watchers, _threshold);
        emit NewStaticOptimisticWatchers(StaticOptimisticWatchers(newWatchers));
        return newWatchers;
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
