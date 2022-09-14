// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInbox} from "../../interfaces/IInbox.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";

/**
 * @title InboxValidatorManager
 * @notice Verifies checkpoints are signed by a quorum of validators and submits
 * them to an Inbox.
 */
contract InboxValidatorManager is MultisigValidatorManager {
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
     * @notice Verifies a signed checkpoint and submits a message for processing.
     * @dev Reverts if `_signatures` is not a quorum of validator signatures.
     * @dev Reverts if `_signatures` is not sorted in ascending order by the signer
     * address, which is required for duplicate detection.
     * @param _inbox The inbox to submit the message to.
     * @param _root The merkle root of the signed checkpoint.
     * @param _index The index of the signed checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @param _message The message to process.
     * @param _proof Merkle proof of inclusion for message's leaf
     * @param _leafIndex Index of leaf in outbox's merkle tree
     */
    function process(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external {
        require(isQuorum(_root, _index, _signatures), "!quorum");
        _inbox.process(_root, _index, _message, _proof, _leafIndex);
    }
}
