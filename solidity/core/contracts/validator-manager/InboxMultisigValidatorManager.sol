// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma abicoder v2;

// ============ Internal Imports ============
import {IInbox} from "../../interfaces/IInbox.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";

/**
 * @title InboxMultisigValidatorManager
 * @notice Verifies checkpoints are signed by a quorum of validators and submits
 * them to an Inbox.
 */
contract InboxMultisigValidatorManager is MultisigValidatorManager {
    // ============ Constructor ============

    /**
     * @param _remoteDomain The remote domain of the outbox chain.
     */
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _remoteDomain,
        address[] memory _validatorSet,
        uint256 _quorumThreshold
    )
        MultisigValidatorManager(_remoteDomain, _validatorSet, _quorumThreshold)
    {}

    // ============ External Functions ============

    /**
     * @notice Submits a checkpoint signed by a quorum of validators to an Inbox.
     * @dev Reverts if _signatures is not a quorum of validator signatures.
     * @dev Reverts if _signatures is not sorted in ascending order by the signer
     * 		  address, which is required for duplicate detection.
     * @param _inbox The inbox to submit the checkpoint to.
     * @param _root The merkle root of the checkpoint.
     * @param _index The index of the checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * 		      quorum. Must be sorted in ascending order by signer address.
     */
    function checkpoint(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures
    ) external {
        require(isQuorum(_root, _index, _signatures), "!quorum");
        _inbox.checkpoint(_root, _index);
    }
}
