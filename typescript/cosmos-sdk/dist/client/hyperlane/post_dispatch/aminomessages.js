'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.createPostDispatchAminoConverter = void 0;
const createPostDispatchAminoConverter = () => {
  return {
    '/hyperlane.core.v1.MsgClaim': {
      aminoType: 'hyperlane/MsgClaim',
      toAmino: (msg) => ({
        sender: msg.sender,
        igp_id: msg.igp_id,
      }),
      fromAmino: (msg) => ({
        sender: msg.sender,
        igp_id: msg.igp_id,
      }),
    },
    '/hyperlane.core.v1.MsgCreateIgp': {
      aminoType: 'hyperlane/MsgCreateIgp',
      toAmino: (msg) => ({
        owner: msg.owner,
        denom: msg.denom,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        denom: msg.denom,
      }),
    },
    '/hyperlane.core.v1.MsgCreateMerkleTreeHook': {
      aminoType: 'hyperlane/MsgCreateMerkleTreeHook',
      toAmino: (msg) => ({
        owner: msg.owner,
        mailbox_id: msg.mailbox_id,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        mailbox_id: msg.mailbox_id,
      }),
    },
    '/hyperlane.core.v1.MsgCreateNoopHook': {
      aminoType: 'hyperlane/MsgCreateNoopHook',
      toAmino: (msg) => ({
        owner: msg.owner,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
      }),
    },
    '/hyperlane.core.v1.MsgPayForGas': {
      aminoType: 'hyperlane/MsgPayForGas',
      toAmino: (msg) => ({
        sender: msg.sender,
        igp_id: msg.igp_id,
        message_id: msg.message_id,
        destination_domain: msg.destination_domain,
        gas_limit: msg.gas_limit,
        amount: msg.amount,
      }),
      fromAmino: (msg) => ({
        sender: msg.sender,
        igp_id: msg.igp_id,
        message_id: msg.message_id,
        destination_domain: msg.destination_domain,
        gas_limit: msg.gas_limit,
        amount: msg.amount,
      }),
    },
    '/hyperlane.core.v1.MsgSetDestinationGasConfig': {
      aminoType: 'hyperlane/MsgSetDestinationGasConfig',
      toAmino: (msg) => ({
        owner: msg.owner,
        igp_id: msg.igp_id,
        destination_gas_config: msg.destination_gas_config,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        igp_id: msg.igp_id,
        destination_gas_config: msg.destination_gas_config,
      }),
    },
    '/hyperlane.core.v1.MsgSetIgpOwner': {
      aminoType: 'hyperlane/MsgSetIgpOwner',
      toAmino: (msg) => ({
        owner: msg.owner,
        igp_id: msg.igp_id,
        new_owner: msg.new_owner,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        igp_id: msg.igp_id,
        new_owner: msg.new_owner,
      }),
    },
  };
};
exports.createPostDispatchAminoConverter = createPostDispatchAminoConverter;
//# sourceMappingURL=aminomessages.js.map
