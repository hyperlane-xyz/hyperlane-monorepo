'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.createInterchainSecurityAminoConverter = void 0;
const createInterchainSecurityAminoConverter = () => {
  return {
    '/hyperlane.core.v1.MsgAnnounceValidator': {
      aminoType: 'hyperlane/MsgAnnounceValidator',
      toAmino: (msg) => ({
        validator: msg.validator,
        storage_location: msg.storage_location,
        signature: msg.signature,
        mailbox_id: msg.mailbox_id,
        creator: msg.creator,
      }),
      fromAmino: (msg) => ({
        validator: msg.validator,
        storage_location: msg.storage_location,
        signature: msg.signature,
        mailbox_id: msg.mailbox_id,
        creator: msg.creator,
      }),
    },
    '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm': {
      aminoType: 'hyperlane/MsgCreateMerkleRootMultisigIsm',
      toAmino: (msg) => ({
        creator: msg.creator,
        validators: msg.validators,
        threshold: msg.threshold,
      }),
      fromAmino: (msg) => ({
        creator: msg.creator,
        validators: msg.validators,
        threshold: msg.threshold,
      }),
    },
    '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm': {
      aminoType: 'hyperlane/MsgCreateMessageIdMultisigIsm',
      toAmino: (msg) => ({
        creator: msg.creator,
        validators: msg.validators,
        threshold: msg.threshold,
      }),
      fromAmino: (msg) => ({
        creator: msg.creator,
        validators: msg.validators,
        threshold: msg.threshold,
      }),
    },
    '/hyperlane.core.v1.MsgCreateNoopIsm': {
      aminoType: 'hyperlane/MsgCreateNoopIsm',
      toAmino: (msg) => ({
        creator: msg.creator,
      }),
      fromAmino: (msg) => ({
        creator: msg.creator,
      }),
    },
  };
};
exports.createInterchainSecurityAminoConverter =
  createInterchainSecurityAminoConverter;
//# sourceMappingURL=aminomessages.js.map
