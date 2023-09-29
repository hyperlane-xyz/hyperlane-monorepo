// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

// ============ Internal Imports ============
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

// ============ Custom Errors ============
error NotAWatcher();
error InvalidAddress();
error AlreadyVoted(address);
error AlreadyBeingVerified(bytes);
error NotPreverified(bytes);
error FraudWindowNotPassed();
error FraudulentISM(address);

abstract contract AbstractOptimisticIsm is IOptimisticIsm, OwnableUpgradeable {
    // ============ Constants ============
    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OPTIMISTIC);

    // ============ Structs ============
    struct FraudVerification {
        uint8 thresholdCount;
        mapping(address => bool) votedFraudulent;
    }

    // ============ Mutable Storage ============
    uint32 fraudWindow;
    address submoduleAddr;
    mapping(bytes => uint256) public preverifiedAtTime;
    mapping(address => FraudVerification) public isFraudulent;

    // ============ Events ============
    event NewSubmoduleSet(address indexed newSubmodule);
    event NewFraudWindowSet(uint32 indexed fraudWindow);
    event Preverified(bytes indexed message, bytes indexed metadata);
    event Verified(bytes indexed message, bytes indexed metadata);
    event DeclaredFraudulent(
        address indexed submodule,
        address indexed watcher
    );

    /**
     * @param _owner The owner of the contract.
     */
    function initialize(address _owner) public initializer {
        __Ownable_init();
        _transferOwnership(_owner);
    }

    // ============ External Functions ============
    /**
     * @notice Sets the submodule. Only done by admin.
     * @param _submodule The ISM used for verification
     */
    function setSubmodule(address _submodule) external onlyOwner {
        submoduleAddr = _submodule;
        emit NewSubmoduleSet(_submodule);
    }

    /**
     * @notice Changes the length of the fraud window
     * @param _time The time required before something can be fully verified
     */
    function changeFraudWindow(uint32 _time) external onlyOwner {
        fraudWindow = _time;
        emit NewFraudWindowSet(_time);
    }

    /**
     * @notice The way for a watcher to declare that an ISM is fraudulent
     * @dev Only a watcher can call, one vote per watcher, verification counter increments on successful call
     * @param _submodule The ISM to declare fraudulent
     */
    function markFraudulent(address _submodule) external {
        if (!_isWatcher(msg.sender)) {
            revert NotAWatcher();
        }
        FraudVerification storage verification = isFraudulent[_submodule];
        if (verification.votedFraudulent[msg.sender]) {
            revert AlreadyVoted(msg.sender);
        }
        verification.votedFraudulent[msg.sender] = true;
        unchecked {
            ++verification.thresholdCount;
        }
        emit DeclaredFraudulent(_submodule, msg.sender);
    }

    /**
     * @notice Returns the current submodule being used for verification
     * @dev Normally this would use some parameters in the message to determine what submodule to use
     * but for now we will be using a static address that's pointed at storage.
     * @param _message The hypothetical message that would atler the ISM
     * @return IInterChainSecurityModule the ISM
     */
    function submodule(
        bytes calldata _message
    ) external view virtual returns (IInterchainSecurityModule) {
        return IInterchainSecurityModule(submoduleAddr);
    }

    /**
     * @notice Preverifies the message that is to be sent to the foreign chain in the Optimstic module
     * @dev Stores the preverification time and uses it as a placeholder to know that preverification has been
     * instantiated
     * @param _message The message to verify
     * @param _metadata The metadata to be used for verification
     * @return bool Whether preverification succeeded or not
     */
    function preVerify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        if (preverifiedAtTime[_message] != 0) {
            revert AlreadyBeingVerified(_message);
        }
        IInterchainSecurityModule ism = this.submodule(_message);
        bool verified = ism.verify(_metadata, _message);
        if (verified) {
            preverifiedAtTime[_message] = block.timestamp;
            emit Preverified(_message, _metadata);
            return true;
        }
        return false;
    }

    /**
     * @notice Verifies the message that is to be sent to the foreign chain in the Optimstic module
     * @dev Needs to pass fraud window, preverification, and ISM fraud from watchers
     * @param _message The message to verify
     * @param _metadata The metadata to be used for verification
     * @return bool Whether verification succeeded or not
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        uint256 preverifiedTime = preverifiedAtTime[_message];
        if (preverifiedTime == 0) revert NotPreverified(_message);
        if (block.timestamp < preverifiedTime + uint256(fraudWindow))
            revert FraudWindowNotPassed();
        if (!_passesWatcherFraudVerification())
            revert FraudulentISM(submoduleAddr);
        delete preverifiedAtTime[_message]; // collect refund
        emit Verified(_message, _metadata);
        return true;
    }

    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    /**
     * @dev Use a metaproxy to get embedded watchers and threshold in ISM
     */
    function watchersAndThreshold()
        public
        view
        virtual
        returns (address[] memory, uint8);

    // ============ Internal Functions ============
    /**
     * @dev Used to determine if an address is a watcher
     */
    function _isWatcher(address watcher) internal view returns (bool) {
        (address[] memory watchers, ) = watchersAndThreshold();
        uint i;
        for (; i < watchers.length; ) {
            if (watchers[i] == watcher) return true;
            unchecked {
                ++i; // gas optimization
            }
        }
        return false;
    }

    /**
     * @dev Used to determine if an ISM passes fraud verification
     */
    function _passesWatcherFraudVerification() internal view returns (bool) {
        uint8 fvThresholdCount = isFraudulent[submoduleAddr].thresholdCount;
        (, uint8 threshold) = watchersAndThreshold();
        return (fvThresholdCount < threshold);
    }
}
