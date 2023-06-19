// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

// ============ Internal Imports ============
import {AbstractOptimisticIsm} from "./AbstractOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title SimpleOptimisticIsm
 */
contract SimpleOptimisticIsm is AbstractOptimisticIsm, OwnableUpgradeable {
    // ============ Public Storage ============
    IInterchainSecurityModule public module;
    mapping(bytes32 => bool) public isVerified;
    mapping(address => bool) public isWatcher;
    mapping(bytes32 => bool) public hasMarkedFraud; // has watcher marked as fraud a submoodule (stops watchers from voting multiple times)
    mapping(address => bool) public isFraud; // is submodule fraudulent
    uint8 public fraudCount;
    uint8 public fraudCountTreshold;
    uint public fraudWindow;
    uint public fraudWindowExpire;

    // ============ Events ============

    /**
     * @notice Emitted when a module is set for a domain
     * @param module The ISM to use.
     */
    event ModuleSet(IInterchainSecurityModule module);
    event FraudWindowSet(uint fraudWindow);
    event FraudCountSet(uint8 fraudCountTreshold);
    event WatcherSet(address _watcher, bool _isWatcher);

    // ============ External Functions ============

    /**
     * @param _owner The owner of the contract.
     */
    function initialize(address _owner) public initializer {
        __Ownable_init();
        _transferOwnership(_owner);
    }

    /**
     * @notice Sets the ISMs to be used for the specified origin domains
     * @param _owner The owner of the contract.
     * @param _module The ISM to use to verify messages
     */
    function initialize(
        address _owner,
        IInterchainSecurityModule _module,
        uint _fraudWindow,
        uint8 _fraudCountTreshold,
        address[] calldata _watchers
    ) public initializer {
        __Ownable_init();
        _set(_module);
        _setFraudCountTreshold(_fraudCountTreshold);
        _setFraudWindow(_fraudWindow);
        _transferOwnership(_owner);
        _resetCurrentState();
        // watchers can only be set at initialization
        for (uint i = 0; i < _watchers.length; i++) {
            _setWatcher(_watchers[i], true);
        }
    }

    /**
     * @notice Sets the ISM to be used for the specified origin domain
     * @param _module The ISM to use to verify messages
     */
    function set(IInterchainSecurityModule _module) external onlyOwner {
        _set(_module);
    }

    function setFraudCountTreshold(
        uint8 _fraudCountTreshold
    ) external onlyOwner {
        // there is an issue if the argument is 0 a bad watcher can expoit TODO
        // possible solution is too set a minimum
        _setFraudCountTreshold(_fraudCountTreshold);
    }

    function setFraudWindow(uint _fraudWindow) external onlyOwner {
        // there is an issue if the argument is 0 a bad watcher can expoit TODO
        _setFraudWindow(_fraudWindow);
    }

    function setWatcher(address _watcher, bool _isWatcher) external onlyOwner {
        _setWatcher(_watcher, _isWatcher);
    }

    // ============ Public Functions ============

    /**
     * @notice Returns the ISM responsible for verifying _message
     * @dev Can be copnfigured by the owner of the OptimisticISM
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message
     */
    function submodule(
        bytes calldata _message
    ) public view virtual override returns (IInterchainSecurityModule) {
        require(
            address(module) != address(0),
            "No ISM found for origin domain"
        );
        require(
            !isFraud[address(module)],
            "submodule alows fraudulent messages"
        );
        return module;
    }

    function isPreVerified() public view virtual override returns (bool) {
        require(
            !isFraud[address(module)],
            "submodule alows fraudulent messages"
        );
        require(isFraudWindowExpired(), "fraud window still open");
        return false;
    }

    function isFraudWindowExpired() public view virtual returns (bool) {
        return fraudWindowExpire < block.number;
    }

    function preVerify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        isPreVerified();
        return submodule(_message).verify(_metadata, _message);
    }

    function markFraudulent(address _submodule) external {
        require(isWatcher[msg.sender], "!watcher");
        bytes32 modWatcherHash = keccak256(
            abi.encodePacked(msg.sender, _submodule)
        );
        require(!hasMarkedFraud[modWatcherHash], "watcher has marked before");
        if (fraudCount == fraudCountTreshold) {
            isFraud[_submodule] = true;
        } else {
            hasMarkedFraud[modWatcherHash] = true;
            fraudCount += 1; // solidity ver 0.8.x does not need safe math
        }
    }

    // ============ Internal Functions ============
    /**
     * @notice Resets the state of the fraud count and window
     */
    function _resetCurrentState() internal {
        fraudWindowExpire = block.number + fraudWindow;
        fraudCount = 0;
    }

    /**
     * @notice Sets the ISM to be used
     * @param _module The ISM to use to verify messages
     */
    function _set(IInterchainSecurityModule _module) internal {
        require(Address.isContract(address(_module)), "!contract");
        _resetCurrentState();
        module = _module;
        emit ModuleSet(_module);
    }

    function _setFraudCountTreshold(uint8 _fraudCountTreshold) internal {
        fraudCountTreshold = _fraudCountTreshold;
        emit FraudCountSet(_fraudCountTreshold);
    }

    function _setWatcher(address _watcher, bool _isWatcher) internal {
        isWatcher[_watcher] = _isWatcher;
        emit WatcherSet(_watcher, _isWatcher);
    }

    function _setFraudWindow(uint _fraudWindow) internal {
        fraudWindow = _fraudWindow;
        emit FraudWindowSet(_fraudWindow);
    }
}
