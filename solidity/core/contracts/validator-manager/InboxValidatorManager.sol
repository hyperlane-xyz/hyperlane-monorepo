// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IInbox} from "../../interfaces/IInbox.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";

/**
 * @title InboxValidatorManager
 * @notice Verifies checkpoints are signed by a quorum of validators and submits
 * them to an Inbox.
 */
contract InboxValidatorManager is MultisigValidatorManager {
    // ============ Events ============

    /**
     * @notice Emitted when a checkpoint has been signed by a quorum
     * of validators and cached on an Inbox.
     * @dev This event allows watchers to observe the signatures they need
     * to prove fraud on the Outbox.
     * @param signatures The signatures by a quorum of validators on the
     * checkpoint.
     */
    event Quorum(bytes32 root, uint256 index, bytes[] signatures);
    event Quorum2(bytes32 root, uint256 index, bytes32 signature, bytes32[] missing);
    event Quorum3(bytes32 root, uint256 index);

    // ============ Constructor ============

    /**
     * @dev Reverts if `_validators` has any duplicates.
     * @param _remoteDomain The remote domain of the outbox chain.
     * @param _validators The set of validator addresses.
     * @param _threshold The quorum threshold. Must be greater than or equal
     * to the length of `_validators`.
     */
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _remoteDomain,
        address[] memory _validators,
        uint256 _threshold
    ) MultisigValidatorManager(_remoteDomain, _validators, _threshold) {}

    // ============ External Functions ============

    /**
     * @notice Submits a checkpoint signed by a quorum of validators to be cached by an Inbox.
     * @dev Reverts if `_signatures` is not a quorum of validator signatures.
     * @dev Reverts if `_signatures` is not sorted in ascending order by the signer
     * address, which is required for duplicate detection.
     * @param _inbox The inbox to submit the checkpoint to.
     */
    function process(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures,
        // address[] calldata _missing,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external {
        // require(isQuorum2(_root, _index, _signatures, _missing), "!quorum");
        require(isQuorum(_root, _index, _signatures), "!quorum");
        // emit Quorum(_root, _index, _signatures);
        // emit Quorum2(_root, _index, _root, missing);
        emit Quorum3(_root, _index);
        _inbox.process(_root, _index, _message, _proof, _leafIndex, "0x00");
    }
}
