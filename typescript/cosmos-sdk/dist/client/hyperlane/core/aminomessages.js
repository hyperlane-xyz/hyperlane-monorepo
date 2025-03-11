'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.createCoreAminoConverter = void 0;
const createCoreAminoConverter = () => {
  return {
    '/hyperlane.core.v1.MsgCreateMailbox': {
      aminoType: 'hyperlane/MsgCreateMailbox',
      toAmino: (msg) => ({
        owner: msg.owner,
        local_domain: msg.local_domain,
        default_ism: msg.default_ism,
        default_hook: msg.default_hook,
        required_hook: msg.required_hook,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        local_domain: msg.local_domain,
        default_ism: msg.default_ism,
        default_hook: msg.default_hook,
        required_hook: msg.required_hook,
      }),
    },
    '/hyperlane.core.v1.MsgSetMailbox': {
      aminoType: 'hyperlane/MsgSetMailbox',
      toAmino: (msg) => ({
        owner: msg.owner,
        mailbox_id: msg.mailbox_id,
        default_ism: msg.default_ism,
        default_hook: msg.default_hook,
        required_hook: msg.required_hook,
        new_owner: msg.new_owner,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        mailbox_id: msg.mailbox_id,
        default_ism: msg.default_ism,
        default_hook: msg.default_hook,
        required_hook: msg.required_hook,
        new_owner: msg.new_owner,
      }),
    },
    '/hyperlane.core.v1.MsgProcessMessage': {
      aminoType: 'hyperlane/MsgProcessMessage',
      toAmino: (msg) => ({
        mailbox_id: msg.mailbox_id,
        relayer: msg.relayer,
        metadata: msg.metadata,
        message: msg.message,
      }),
      fromAmino: (msg) => ({
        mailbox_id: msg.mailbox_id,
        relayer: msg.relayer,
        metadata: msg.metadata,
        message: msg.message,
      }),
    },
  };
};
exports.createCoreAminoConverter = createCoreAminoConverter;
//# sourceMappingURL=aminomessages.js.map
