// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IOutbox} from "../../interfaces/IOutbox.sol";
import {MerkleLib} from "../../libs/Merkle.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";

/**
 * @title OutboxValidatorManager
 * @notice Verifies if an invalid or fraudulent checkpoint has been signed by a quorum of
 * validators and reports it to an Outbox.
 */
contract OutboxValidatorManager is MultisigValidatorManager {
    // ============ Events ============

    /**
     * @notice Emitted when proof of an invalid checkpoint is submitted.
     * @dev Observers of this event should filter by the outbox address.
     * @param outbox The outbox.
     * @param root Root of the invalid checkpoint.
     * @param index Index of the invalid checkpoint.
     * @param signatures A quorum of signatures on the invalid checkpoint.
     * May include non-validator signatures.
     */
    event InvalidCheckpoint(
        address indexed outbox,
        bytes32 root,
        uint256 index,
        bytes[] signatures
    );

    /**
     * @notice Emitted when proof of a fraudulent checkpoint is submitted.
     * @dev Observers of this event should filter by the outbox address.
     * @param outbox The outbox.
     * @param root Root of the fraudulent checkpoint.
     * @param index Index of the fraudulent checkpoint.
     * @param signatures A quorum of signatures on the fraudulent checkpoint.
     * May include non-validator signatures.
     */
    event FraudulentCheckpoint(
        address indexed outbox,
        bytes32 root,
        uint256 index,
        bytes[] signatures
    );

    // ============ Constructor ============

    /**
     * @dev Reverts if `_validators` has any duplicates.
     * @param _localDomain The local domain.
     * @param _validators The set of validator addresses.
     * @param _threshold The quorum threshold. Must be greater than or equal
     * to the length of `_validators`.
     */
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _localDomain,
        address[] memory _validators,
        uint256 _threshold
    ) MultisigValidatorManager(_localDomain, _validators, _threshold) {}

    // ============ External Functions ============

    /**
     * @notice Determines if a quorum of validators have signed an invalid checkpoint,
     * failing the Outbox if so.
     * An invalid checkpoint is one in which the index is greater than the latest leaf
     * index in the Outbox's merkle tree.
     * @dev Invalid checkpoints signed by individual validators are not handled to prevent
     * a single byzantine validator from failing the Outbox.
     * @param _outbox The outbox.
     * @param _signedRoot The root of the signed checkpoint.
     * @param _signedIndex The index of the signed checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @return True iff fraud was proved.
     */
    function invalidCheckpoint(
        IOutbox _outbox,
        bytes32 _signedRoot,
        uint256 _signedIndex,
        bytes[] calldata _signatures
    ) external returns (bool) {
        require(isQuorum(_signedRoot, _signedIndex, _signatures), "!quorum");
        // Checkpoints are invalid if the Outbox does not have a message
        // in the checkpoint's leaf index.
        require(_signedIndex + 1 > _outbox.count(), "!invalid");
        _outbox.fail();
        emit InvalidCheckpoint(
            address(_outbox),
            _signedRoot,
            _signedIndex,
            _signatures
        );
        return true;
    }

    /**
     * @notice Determines if a quorum of validators have signed a fraudulent checkpoint,
     * failing the Outbox if so.
     * If the Outbox's merkle root commits to message M at leaf index J, a fraudulent checkpoint
     * commits to M' != M at leaf index J.
     * @dev Fraudulent checkpoints signed by individual validators are not handled to prevent
     * a single byzantine validator from failing the Outbox.
     * @param _outbox The outbox.
     * @param _signedIndex The index of the signed checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @param _fraudulentLeaf The differing element in the fraudulent tree.
     * @param _fraudulentProof Proof of inclusion of `_fraudulentLeaf`.
     * @param _actualLeaf The actual leaf in Outbox's tree.
     * @param _actualProof Proof of inclusion of `_actualLeaf`.
     * @param _leafIndex The index of the disputed leaf.
     * @return True iff fraud was proved.
     */
    function fraudulentCheckpoint(
        IOutbox _outbox,
        uint256 _signedIndex,
        bytes[] calldata _signatures,
        bytes32 _fraudulentLeaf,
        bytes32[32] calldata _fraudulentProof,
        bytes32 _actualLeaf,
        bytes32[32] calldata _actualProof,
        uint256 _leafIndex
    ) external returns (bool) {
        // Check the signed checkpoint commits to _fraudulentLeaf at _leafIndex.
        bytes32 _signedRoot = MerkleLib.branchRoot(
            _fraudulentLeaf,
            _fraudulentProof,
            _leafIndex
        );
        require(isQuorum(_signedRoot, _signedIndex, _signatures), "!quorum");

        // Check the cached checkpoint commits to _actualLeaf at _leafIndex.
        bytes32 _cachedRoot = MerkleLib.branchRoot(
            _actualLeaf,
            _actualProof,
            _leafIndex
        );
        uint256 _cachedIndex = _outbox.cachedCheckpoints(_cachedRoot);
        require(_cachedIndex >= _signedIndex, "!cache");

        // Check that the signed and cached checkpoints commit to different
        // leaves at the same leaf index.
        require(_fraudulentLeaf != _actualLeaf, "!fraudulent");

        // Fail the Outbox.
        _outbox.fail();
        emit FraudulentCheckpoint(
            address(_outbox),
            _signedRoot,
            _signedIndex,
            _signatures
        );
        return true;
    }
}
