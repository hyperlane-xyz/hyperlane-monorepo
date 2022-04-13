// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma abicoder v2;

// ============ Internal Imports ============
import {IOutbox} from "../../interfaces/IOutbox.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";

/**
 * @title OutboxMultisigValidatorManager
 * @notice Verifies if an improper checkpoint has been signed by a quorum of
 * validators and reports it to an Outbox.
 */
contract OutboxMultisigValidatorManager is MultisigValidatorManager {
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
        bytes32 indexed root,
        uint256 index,
        bytes[] signatures
    );

    // ============ Constructor ============

    /**
     * @dev Reverts if _validators has any duplicates.
     * @param _localDomain The local domain.
     * @param _validators The set of validator addresses.
     * @param _quorumThreshold The quorum threshold. Must be greater than or equal
     * to the length of _validators.
     */
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _localDomain,
        address[] memory _validators,
        uint256 _quorumThreshold
    ) MultisigValidatorManager(_localDomain, _validators, _quorumThreshold) {}

    // ============ External Functions ============

    /**
     * @notice Determines if a quorum of validators have signed an improper checkpoint,
     * failing the Outbox if so.
     * @dev Improper checkpoints signed by individual validators are not handled to prevent
     * a single byzantine validator from failing the Outbox.
     * @param _outbox The outbox.
     * @param _root The merkle root of the checkpoint.
     * @param _index The index of the checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     */
    function improperCheckpoint(
        IOutbox _outbox,
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures
    ) external {
        require(isQuorum(_root, _index, _signatures), "!quorum");
        require(!_outbox.isCheckpoint(_root, _index), "!improper checkpoint");
        _outbox.fail();
        emit ImproperCheckpoint(address(_outbox), _root, _index, _signatures);
    }
}
