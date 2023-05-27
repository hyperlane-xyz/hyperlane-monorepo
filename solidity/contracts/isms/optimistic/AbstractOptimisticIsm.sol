// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title AbstractOptimisticIsm
 * @notice Optimistic ISMs pre-verify messages before routing them to the correct ISM
 * @dev The relayer must call preVerify then wait for the fraud window to pass before calling verify
 * For optimistic verification to succeed, three conditions must be satisfied:
 * 1. the message was pre-verified
 * 2. the submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchers
 * 3. the fraud window has elapsed
 */
abstract contract AbstractOptimisticIsm is IOptimisticIsm {
    // ============ Public Storage ============
    // Mapping to track if a module is flagged as fraudulent by a watcher
    mapping(address => mapping(address => bool)) public fraudulent;

    // Mapping to count the unique number of times an ISM has been flagged as fraudulent
    mapping(address => uint256) public fraudulentCounter;

    // Mapping to store pre-verification data of a message using its ID
    mapping(bytes32 => PreVerificationData) public preVerification;

    // ============= Structs =============
    struct PreVerificationData {
        address submodule;
        uint96 timestamp;
    }

    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OPTIMISTIC);

    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    /**
     * @notice Marks an ISM as fraudulent
     * @param ism The address of ISM to mark as fraudulent
     */
    function markFraudulent(address ism) external virtual;

    /**
     * @notice Returns the list of watchers and threshold used for this optimistic ISM
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return watchers The list of watchers
     * @return threshold The threshold of watchers needed to mark an ISM as fraudulent
     */
    function watchersAndThreshold(bytes calldata _message)
        public
        view
        virtual
        returns (address[] memory watchers, uint8 threshold);

    /**
     * @notice Returns the ISM responsible for verifying _message
     * @dev Can change based on the content of _message
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message
     */
    function submodule(bytes calldata _message)
        public
        view
        virtual
        returns (IInterchainSecurityModule);

    /**
     * @notice Returns the fraud window for a given message
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function fraudWindow(bytes calldata _message)
        public
        view
        virtual
        returns (uint256);

    // ============ Public Functions ============

    /**
     * @notice Pre-verifies _message using the currently configuered submodule
     * @dev before calling verify, a relayer will call preVerify to ensure that the message is valid
     * @param _metadata Formatted arbitrary bytes that can be specified by an off-chain relayer
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return Whether or not the message is valid
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        public
        returns (bool)
    {
        IInterchainSecurityModule _submodule = submodule(_message);
        bytes32 _id = Message.id(_message);
        PreVerificationData memory _pvd = preVerification[_id];
        require(_pvd.submodule == address(0), "preVerified");
        preVerification[_id] = PreVerificationData({
            submodule: address(_submodule),
            timestamp: uint96(block.timestamp)
        });
        require(_submodule.verify(_metadata, _message), "!verify");
        return true;
    }

    /**
     * @notice Routes _metadata and _message to the correct ISM
     * @dev For optimistic verification to succeed three conditions must be satisfied
     * 1. the message was pre-verfied by the submodule
     * 2. the submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchers
     * 3. fraud window has elapsed
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata, bytes calldata _message)
        public
        returns (bool)
    {
        bytes32 _id = Message.id(_message);
        PreVerificationData memory _pvd = preVerification[_id];
        require(_pvd.timestamp > 0, "!isPreVerified");
        require(
            _pvd.timestamp + fraudWindow(_message) < block.timestamp,
            "!fraudWindow"
        );
        (, uint8 _threshold) = watchersAndThreshold(_message);
        require(
            fraudulentCounter[_pvd.submodule] < _threshold,
            "!fraudThreshold"
        );
        delete preVerification[_id];
        return true;
    }
}
