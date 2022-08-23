// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IOutbox} from "../../interfaces/IOutbox.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";

/**
 * @title OutboxValidatorManager
 * @notice Verifies if an premature or fraudulent checkpoint has been signed by a quorum of
 * validators and reports it to an Outbox.
 */
contract OutboxValidatorManager is MultisigValidatorManager {
    // ============ Events ============

    /**
     * @notice Emitted when a checkpoint is proven premature.
     * @dev Observers of this event should filter by the outbox address.
     * @param outbox The outbox.
     * @param signedRoot Root of the premature checkpoint.
     * @param signedIndex Index of the premature checkpoint.
     * @param signatures A quorum of signatures on the premature checkpoint.
     * May include non-validator signatures.
     * @param count The number of messages in the Outbox.
     */
    event PrematureCheckpoint(
        address indexed outbox,
        bytes32 signedRoot,
        uint256 signedIndex,
        bytes[] signatures,
        uint256 count
    );

    /**
     * @notice Emitted when a checkpoint is proven fraudulent.
     * @dev Observers of this event should filter by the outbox address.
     * @param outbox The outbox.
     * @param signedRoot Root of the fraudulent checkpoint.
     * @param signedIndex Index of the fraudulent checkpoint.
     * @param signatures A quorum of signatures on the fraudulent checkpoint.
     * May include non-validator signatures.
     * @param fraudulentLeaf The leaf in the fraudulent tree.
     * @param fraudulentProof Proof of inclusion of fraudulentLeaf.
     * @param actualLeaf The leaf in the Outbox's tree.
     * @param actualProof Proof of inclusion of actualLeaf.
     * @param leafIndex The index of the leaves that are being proved.
     */
    event FraudulentCheckpoint(
        address indexed outbox,
        bytes32 signedRoot,
        uint256 signedIndex,
        bytes[] signatures,
        bytes32 fraudulentLeaf,
        bytes32[32] fraudulentProof,
        bytes32 actualLeaf,
        bytes32[32] actualProof,
        uint256 leafIndex
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
        uint256 count = _outbox.count();
        require(_signedIndex >= count, "!premature");
        _outbox.fail();
        emit PrematureCheckpoint(
            address(_outbox),
            _signedRoot,
            _signedIndex,
            _signatures,
            count
        );
        return true;
    }

    /**
     * @notice Determines if a quorum of validators have signed a fraudulent checkpoint,
     * failing the Outbox if so.
     * A checkpoint is fraudulent if the leaf it commits to at index I differs
     * from the leaf the Outbox committed to at index I, where I is less than or equal
     * to the index of the checkpoint.
     * This difference can be proved by comparing two merkle proofs for leaf
     * index J >= I. One against the fraudulent checkpoint, and one against a
     * checkpoint cached on the Outbox.
     * @dev Fraudulent checkpoints signed by individual validators are not handled to prevent
     * a single byzantine validator from failing the Outbox.
     * @param _outbox The outbox.
     * @param _signedRoot The root of the signed checkpoint.
     * @param _signedIndex The index of the signed checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @param _fraudulentLeaf The leaf in the fraudulent tree.
     * @param _fraudulentProof Proof of inclusion of `_fraudulentLeaf`.
     * @param _actualLeaf The leaf in the Outbox's tree.
     * @param _actualProof Proof of inclusion of `_actualLeaf`.
     * @param _leafIndex The index of the leaves that are being proved.
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

        // Check that the two roots commit to at least one differing leaf
        // with index <= _leafIndex.
        require(
            impliesDifferingLeaf(
                _fraudulentLeaf,
                _fraudulentProof,
                _actualLeaf,
                _actualProof,
                _leafIndex
            ),
            "!fraud"
        );

        // Fail the Outbox.
        _outbox.fail();
        emit FraudulentCheckpoint(
            address(_outbox),
            _signedRoot,
            _signedIndex,
            _signatures,
            _fraudulentLeaf,
            _fraudulentProof,
            _actualLeaf,
            _actualProof,
            _leafIndex
        );
        return true;
    }

    /**
     * @notice Returns true if the implied merkle roots commit to at least one
     * differing leaf with index <= `_leafIndex`.
     * Given a merkle proof for leaf index J, we can determine whether an
     * element in the proof is an internal node whose terminal children are leaves
     * with index <= J.
     * Given two merkle proofs for leaf index J, if such elements do not match,
     * these two proofs necessarily commit to at least one differing leaf with
     * index I <= J.
     * @param _leafA The leaf in tree A.
     * @param _proofA Proof of inclusion of `_leafA` in tree A.
     * @param _leafB The leaf in tree B.
     * @param _proofB Proof of inclusion of `_leafB` in tree B.
     * @param _leafIndex The index of `_leafA` and `_leafB`.
     * @return differ True if the implied trees differ, false if not.
     */
    function impliesDifferingLeaf(
        bytes32 _leafA,
        bytes32[32] calldata _proofA,
        bytes32 _leafB,
        bytes32[32] calldata _proofB,
        uint256 _leafIndex
    ) public pure returns (bool) {
        // The implied merkle roots commit to at least one differing leaf
        // with index <= _leafIndex, if either:

        // 1. If the provided leaves differ.
        if (_leafA != _leafB) {
            return true;
        }

        // 2. If the branches contain internal nodes whose subtrees are full
        // (as implied by _leafIndex) that differ from one another.
        for (uint8 i = 0; i < 32; i++) {
            uint256 _ithBit = (_leafIndex >> i) & 0x01;
            // If the i'th is 1, the i'th element in the proof is an internal
            // node whose subtree is full.
            // If these nodes differ, at least one leaf that they commit to
            // must differ as well.
            if (_ithBit == 1) {
                if (_proofA[i] != _proofB[i]) {
                    return true;
                }
            }
        }
        return false;
    }
}
