// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {MessageIdMultisigIsmMetadata} from "../../libs/isms/MessageIdMultisigIsmMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {CheckpointLib} from "../../libs/CheckpointLib.sol";

/**
 * @title MultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used to verify
 * interchain messages.
 */
abstract contract AbstractMessageIdMultisigIsm is AbstractMultisigIsm {
    // ============ Constants ============

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
        returns (bytes memory signature)
    {
        return MessageIdMultisigIsmMetadata.signatureAt(_metadata, _index);
    }
}
