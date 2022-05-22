// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IOutbox} from "../../interfaces/IOutbox.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";

/**
 * @title OutboxValidatorManager
 * @notice Verifies if an improper checkpoint has been signed by a quorum of
 * validators and reports it to an Outbox.
 */
contract OutboxValidatorManager is MultisigValidatorManager {
    // ============ Events ============

    /**
     * @notice Emitted when proof of an improper checkpoint is submitted.
     * @dev Observers of this event should filter by the outbox address.
     * @param outbox The outbox.
     * @param root Root of the improper checkpoint.
     * @param index Index of the improper checkpoint.
     * @param signatures A quorum of signatures on the improper checkpoint.
     * May include non-validator signatures.
     */
    event ImproperCheckpoint(
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
     * @notice Returns true if `_fraudulentRoot was proved to never have been a
     * valid root for the Outbox, by checking a proof that `_fraudulentRoot`
     * and the Outbox's actual root contain different leaves at the same index.
     * @param _outbox The outbox.
     * @param _fraudulentRoot The merkle root used to verify inclusion of `_fraudulentLeaf`.
     * @param _fraudulentLeaf The differing element in the fraudulent tree.
     * @param _fraudulentProof Proof of inclusion of `_fraudulentLeaf`.
     * @param _actualLeaf The actual leaf in Outbox's tree.
     * @param _actualProof Proof of inclusion of `_actualLeaf`.
     * @param _index The index of the disputed leaf.
     * @return True iff fraud was proved.
     */
    function verifyFraudProof(IOutbox _outbox, bytes32 _fraudulentRoot, bytes32 _fraudulentLeaf, bytes32[32] calldata _fraudulentProof, bytes32 _actualLeaf, bytes32[32] calldata _actualProof, uint256 _index) public view returns (bool) {
        require(_fraudulentLeaf != _actualLeaf, "leaves match");
        require(_outbox.verifyMerkleProof(_fraudulentRoot, _fraudulentLeaf, _fraudulentProof, _index), "!fraud proof");
        require(_outbox.verifyMerkleProof(_outbox.root(), _actualLeaf, _actualProof, _index), "!actual proof");
        return true;
    }

    /**
     * @notice Determines if a quorum of validators have signed an improper checkpoint,
     * failing the Outbox if so.
     * @dev Improper checkpoints signed by individual validators are not handled to prevent
     * a single byzantine validator from failing the Outbox.
     * @param _outbox The outbox.
     * @param _checkpointRoot The merkle root of the signed checkpoint.
     * @param _checkpointIndex The index of the signed checkpoint.
     * @param _checkpointSignatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @param _fraudulentLeaf The differing element in the fraudulent tree.
     * @param _fraudulentProof Proof of inclusion of `_fraudulentLeaf`.
     * @param _actualLeaf The actual leaf in Outbox's tree.
     * @param _actualProof Proof of inclusion of `_actualLeaf`.
     * @param _index The index of the disputed leaf.
     */
    function improperCheckpoint(
        IOutbox _outbox,
        bytes32 _checkpointRoot,
        uint256 _checkpointIndex,
        bytes[] calldata _checkpointSignatures,
        bytes32 _fraudulentLeaf,
        bytes32[32] calldata _fraudulentProof,
        bytes32 _actualLeaf,
        bytes32[32] calldata _actualProof,
        uint256 _index
    ) external {
        require(isQuorum(_checkpointRoot, _checkpointIndex, _checkpointSignatures), "!quorum");
        require(verifyFraudProof(_outbox, _checkpointRoot, _fraudulentLeaf, _fraudulentProof, _actualLeaf, _actualProof, _index), "!fraud");
        _outbox.fail();
        emit ImproperCheckpoint(address(_outbox), _checkpointRoot, _checkpointIndex, _checkpointSignatures);
    }
}
