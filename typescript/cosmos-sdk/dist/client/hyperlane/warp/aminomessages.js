'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.createWarpAminoConverter = void 0;
const createWarpAminoConverter = () => {
  return {
    '/hyperlane.warp.v1.MsgCreateCollateralToken': {
      aminoType: 'hyperlane/MsgCreateCollateralToken',
      toAmino: (msg) => ({
        owner: msg.owner,
        origin_mailbox: msg.origin_mailbox,
        origin_denom: msg.origin_denom,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        origin_mailbox: msg.origin_mailbox,
        origin_denom: msg.origin_denom,
      }),
    },
    '/hyperlane.warp.v1.MsgCreateSyntheticToken': {
      aminoType: 'hyperlane/MsgCreateSyntheticToken',
      toAmino: (msg) => ({
        owner: msg.owner,
        origin_mailbox: msg.origin_mailbox,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        origin_mailbox: msg.origin_mailbox,
      }),
    },
    '/hyperlane.warp.v1.MsgEnrollRemoteRouter': {
      aminoType: 'hyperlane/MsgEnrollRemoteRouter',
      toAmino: (msg) => ({
        owner: msg.owner,
        token_id: msg.token_id,
        remote_router: msg.remote_router,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        token_id: msg.token_id,
        remote_router: msg.remote_router,
      }),
    },
    '/hyperlane.warp.v1.MsgRemoteTransfer': {
      aminoType: 'hyperlane/MsgRemoteTransfer',
      toAmino: (msg) => ({
        sender: msg.sender,
        token_id: msg.token_id,
        destination_domain: msg.destination_domain,
        recipient: msg.recipient,
        amount: msg.amount,
        custom_hook_id: msg.custom_hook_id,
        gas_limit: msg.gas_limit,
        max_fee: msg.max_fee,
        custom_hook_metadata: msg.custom_hook_metadata,
      }),
      fromAmino: (msg) => ({
        sender: msg.sender,
        token_id: msg.token_id,
        destination_domain: msg.destination_domain,
        recipient: msg.recipient,
        amount: msg.amount,
        custom_hook_id: msg.custom_hook_id,
        gas_limit: msg.gas_limit,
        max_fee: msg.max_fee,
        custom_hook_metadata: msg.custom_hook_metadata,
      }),
    },
    '/hyperlane.warp.v1.MsgSetToken': {
      aminoType: 'hyperlane/MsgSetToken',
      toAmino: (msg) => ({
        owner: msg.owner,
        token_id: msg.token_id,
        new_owner: msg.new_owner,
        ism_id: msg.ism_id,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        token_id: msg.token_id,
        new_owner: msg.new_owner,
        ism_id: msg.ism_id,
      }),
    },
    '/hyperlane.warp.v1.MsgUnrollRemoteRouter': {
      aminoType: 'hyperlane/MsgUnrollRemoteRouter',
      toAmino: (msg) => ({
        owner: msg.owner,
        token_id: msg.token_id,
        receiver_domain: msg.receiver_domain,
      }),
      fromAmino: (msg) => ({
        owner: msg.owner,
        token_id: msg.token_id,
        receiver_domain: msg.receiver_domain,
      }),
    },
  };
};
exports.createWarpAminoConverter = createWarpAminoConverter;
//# sourceMappingURL=aminomessages.js.map
