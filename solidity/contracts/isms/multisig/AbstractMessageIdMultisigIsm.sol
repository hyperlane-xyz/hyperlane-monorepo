// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractMultisig} from "./AbstractMultisigIsm.sol";
import {MessageIdMultisigIsmMetadata} from "../libs/MessageIdMultisigIsmMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {CheckpointLib} from "../../libs/CheckpointLib.sol";

/**
 * @title `AbstractMessageIdMultisigIsm` — multi-sig ISM for the censorship-friendly validators.
 * @notice This ISM minimizes gas/performance overhead of the checkpoints verification by compromising on the censorship resistance.
 * For censorship resistance consider using `AbstractMerkleRootMultisigIsm`.
 * If the validators (`validatorsAndThreshold`) skip messages by not sign checkpoints for them,
 * the relayers will not be able to aggregate a quorum of signatures sufficient to deliver these messages via this ISM.
 * Integrations are free to choose the trade-off between the censorship resistance and the gas/processing overhead.
 * @dev Provides the default implementation of verifying signatures over a checkpoint related to a specific message ID.
 * This abstract contract can be customized to change the `validatorsAndThreshold()` (static or dynamic).
 */
abstract contract AbstractMessageIdMultisigIsm is AbstractMultisig {
    using Message for bytes;
    using MessageIdMultisigIsmMetadata for bytes;

    // ============ Constants ============

    /**
     * @inheritdoc AbstractMultisig
     */
    function digest(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal pure override returns (bytes32) {
        return
            CheckpointLib.digest(
                _message.origin(),
                _metadata.originMerkleTreeHook(),
                _metadata.root(),
                _metadata.index(),
                _message.id()
            );
    }

    /**
     * @inheritdoc AbstractMultisig
     */
    function signatureAt(
        bytes calldata _metadata,
        uint256 _index
    ) internal pure virtual override returns (bytes calldata) {
        return _metadata.signatureAt(_index);
    }

    /**
     * @inheritdoc AbstractMultisig
     */
    function signatureCount(
        bytes calldata _metadata
    ) public pure override returns (uint256) {
        return _metadata.signatureCount();
    }
}
