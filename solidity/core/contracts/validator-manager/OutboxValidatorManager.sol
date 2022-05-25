// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IOutbox} from "../../interfaces/IOutbox.sol";
import {MerkleLib} from "../../libs/Merkle.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";

/**
 * @title OutboxValidatorManager
 * @notice Verifies if an invalid, premature, or fraudulent checkpoint has been signed by a quorum of
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
     * @notice Emitted when proof of a premature checkpoint is submitted.
     * @dev Observers of this event should filter by the outbox address.
     * @param outbox The outbox.
     * @param root Root of the premature checkpoint.
     * @param index Index of the premature checkpoint.
     * @param signatures A quorum of signatures on the premature checkpoint.
     * May include non-validator signatures.
     */
    event PrematureCheckpoint(
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
     * A checkpoint is invalid if it commits to anything other than contiguous non-empty leaves
     * from leaf index zero to the leaf index of the checkpoint.
     * @dev Invalid checkpoints signed by individual validators are not handled to prevent
     * a single byzantine validator from failing the Outbox.
     * @param _outbox The outbox.
     * @param _signedRoot The root of the signed checkpoint.
     * @param _signedIndex The index of the signed checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @param _invalidLeaf The differing element in the fraudulent tree.
     * @param _invalidProof Proof of inclusion of `_fraudulentLeaf`.
     * @param _invalidIndex The index of the disputed leaf.
     * @return True iff invalidity was proved.
     */
    function invalidCheckpoint(
        IOutbox _outbox,
        bytes32 _signedRoot,
        uint256 _signedIndex,
        bytes[] calldata _signatures,
        bytes32 _invalidLeaf,
        bytes32[32] calldata _invalidProof,
        uint256 _invalidIndex
    ) external returns (bool) {
        require(isQuorum(_signedRoot, _signedIndex, _signatures), "!quorum");

        bytes32 _invalidRoot = MerkleLib.branchRoot(
            _invalidLeaf,
            _invalidProof,
            _invalidIndex
        );
        require(_invalidRoot == _signedRoot, "!root");

        bool _invalidIfNonEmptyLeaf = _invalidIndex > _signedIndex;
        bool _nonEmptyLeaf = _invalidLeaf != 0;
        require(_invalidIfNonEmptyLeaf == _nonEmptyLeaf, "!invalid");

        // Fail the Outbox.
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
     * @notice Determines if a quorum of validators have signed a premature checkpoint,
     * failing the Outbox if so.
     * A checkpoint is premature if it commits to more messages than are present in the
     * Outbox's merkle tree.
     * @dev Premature checkpoints signed by individual validators are not handled to prevent
     * a single byzantine validator from failing the Outbox.
     * @param _outbox The outbox.
     * @param _signedRoot The root of the signed checkpoint.
     * @param _signedIndex The index of the signed checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @return True iff prematurity was proved.
     */
    function prematureCheckpoint(
        IOutbox _outbox,
        bytes32 _signedRoot,
        uint256 _signedIndex,
        bytes[] calldata _signatures
    ) external returns (bool) {
        require(isQuorum(_signedRoot, _signedIndex, _signatures), "!quorum");
        // Checkpoints are premature if the checkpoint commits to more messages
        // than the Outbox has in its merkle tree.
        require(_signedIndex >= _outbox.count(), "!premature");
        _outbox.fail();
        emit PrematureCheckpoint(
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
     * A checkpoint is fraudulent if it commits to a message that is different
     * than the message committed to by the Outbox at the same leaf index.
     * @dev Fraudulent checkpoints signed by individual validators are not handled to prevent
     * a single byzantine validator from failing the Outbox.
     * @param _outbox The outbox.
     * @param _signedRoot The root of the signed checkpoint.
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
        bytes32 _signedRoot,
        uint256 _signedIndex,
        bytes[] calldata _signatures,
        bytes32 _fraudulentLeaf,
        bytes32[32] calldata _fraudulentProof,
        bytes32 _actualLeaf,
        bytes32[32] calldata _actualProof,
        uint256 _leafIndex
    ) external returns (bool) {
        // Check the signed checkpoint commits to _fraudulentLeaf at _leafIndex.
        require(isQuorum(_signedRoot, _signedIndex, _signatures), "!quorum");
        bytes32 _fraudulentRoot = MerkleLib.branchRoot(
            _fraudulentLeaf,
            _fraudulentProof,
            _leafIndex
        );
        require(_fraudulentRoot == _signedRoot, "!root");
        require(_signedIndex >= _leafIndex, "!index");

        // Check the cached checkpoint commits to _actualLeaf at _leafIndex.
        bytes32 _cachedRoot = MerkleLib.branchRoot(
            _actualLeaf,
            _actualProof,
            _leafIndex
        );
        uint256 _cachedIndex = _outbox.cachedCheckpoints(_cachedRoot);
        require(_cachedIndex > 0 && _cachedIndex >= _leafIndex, "!cache");

        // Check that the signed and cached checkpoints commit to different
        // leaves at the same leaf index.
        require(_fraudulentLeaf != _actualLeaf, "!leaf");

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
