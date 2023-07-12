// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {MessageIdMultisigIsmMetadata} from "../../libs/isms/MessageIdMultisigIsmMetadata.sol";
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
abstract contract AbstractMessageIdMultisigIsm is AbstractMultisigIsm {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MESSAGE_ID_MULTISIG);

    /**
     * @inheritdoc AbstractMultisigIsm
     */
    function digest(bytes calldata _metadata, bytes calldata _message)
        internal
        pure
        override
        returns (bytes32)
    {
        return
            CheckpointLib.digest(
                Message.origin(_message),
                MessageIdMultisigIsmMetadata.originMailbox(_metadata),
                MessageIdMultisigIsmMetadata.root(_metadata),
                Message.nonce(_message),
                Message.id(_message)
            );
    }

    /**
     * @inheritdoc AbstractMultisigIsm
     */
    function signatureAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        virtual
        override
        returns (bytes memory)
    {
        return MessageIdMultisigIsmMetadata.signatureAt(_metadata, _index);
    }
}
