// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma abicoder v2;

// ============ Internal Imports ============
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";
import {Outbox} from "../Outbox.sol";

contract OutboxMultisigValidatorManager is MultisigValidatorManager {
    // ============ Events ============

    /**
     * @notice Emitted when proof of an improper checkpoint is submitted.
     * @param root Root of the improper checkpoint.
     * @param index Index of the improper checkpoint.
     * @param signatures A quorum of signatures on the improper checkpoint.
     */
    event ImproperCheckpoint(
        address indexed outbox,
        bytes32 indexed root,
        uint256 index,
        bytes[] signatures
    );

    // ============ Constructor ============

    /**
     * @param _localDomain The local domain.
     */
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _localDomain,
        address[] memory _validatorSet,
        uint256 _quorumThreshold
    ) MultisigValidatorManager(_localDomain, _validatorSet, _quorumThreshold) {}

    // ============ External Functions ============

    // Determines if a quorum of signers have signed an improper checkpoint,
    // and fails the Outbox if so.
    // If staking / slashing existed, we'd want to check this for individual validator
    // signatures. Because we don't care about that and we don't want a single byzantine
    // validator to be able to fail the outbox, we require a quorum.
    //
    // Gets the domain from IOutbox(_outbox).localDomain(), then
    // requires isQuorum(domain, _root, _index, _signatures),
    // requires that the checkpoint is an improper checkpoint,
    // and calls IOutbox(_outbox).fail(). (Similar behavior as existing improperCheckpoint)
    function improperCheckpoint(
        Outbox _outbox,
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
