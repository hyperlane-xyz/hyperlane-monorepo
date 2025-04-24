import * as types from '@hyperlane-xyz/cosmos-types';

// amino converters can be null by default since the
// converters for proto can be taken. In rare cases
// they can differ, in that instance the amino
// converters can be overridden here by adding the
// methods "toJSON" and "fromJSON".
export const COSMOS_MODULE_MESSAGE_REGISTRY = {
  // Core transactions
  MsgCreateMailbox: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMailbox',
      converter: types.coreTx.MsgCreateMailbox,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMailbox',
    },
  },
  MsgCreateMailboxResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMailboxResponse',
      converter: types.coreTx.MsgCreateMailboxResponse,
    },
  },
  MsgSetMailbox: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetMailbox',
      converter: types.coreTx.MsgSetMailbox,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetMailbox',
    },
  },
  MsgSetMailboxResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetMailboxResponse',
      converter: types.coreTx.MsgSetMailboxResponse,
    },
  },
  MsgProcessMessage: {
    proto: {
      type: '/hyperlane.core.v1.MsgProcessMessage',
      converter: types.coreTx.MsgProcessMessage,
    },
    amino: {
      type: 'hyperlane/v1/MsgProcessMessage',
    },
  },
  MsgProcessMessageResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgProcessMessageResponse',
      converter: types.coreTx.MsgProcessMessageResponse,
    },
  },
  // Interchain security transactions
  MsgCreateMessageIdMultisigIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMessageIdMultisigIsm',
      converter: types.isTx.MsgCreateMessageIdMultisigIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMessageIdMultisigIsm',
    },
  },
  MsgCreateMessageIdMultisigIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMessageIdMultisigIsmResponse',
      converter: types.isTx.MsgCreateMessageIdMultisigIsmResponse,
    },
  },
  MsgCreateMerkleRootMultisigIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMerkleRootMultisigIsm',
      converter: types.isTx.MsgCreateMerkleRootMultisigIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMerkleRootMultisigIsm',
    },
  },
  MsgCreateMerkleRootMultisigIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMerkleRootMultisigIsmResponse',
      converter: types.isTx.MsgCreateMerkleRootMultisigIsmResponse,
    },
  },
  MsgCreateNoopIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateNoopIsm',
      converter: types.isTx.MsgCreateNoopIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateNoopIsm',
    },
  },
  MsgCreateNoopIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateNoopIsmResponse',
      converter: types.isTx.MsgCreateNoopIsmResponse,
    },
  },
  MsgAnnounceValidator: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgAnnounceValidator',
      converter: types.isTx.MsgAnnounceValidator,
    },
    amino: {
      type: 'hyperlane/v1/MsgAnnounceValidator',
    },
  },
  MsgAnnounceValidatorResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgAnnounceValidatorResponse',
      converter: types.isTx.MsgAnnounceValidatorResponse,
    },
  },
  // Post dispatch transactions
  MsgCreateIgp: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateIgp',
      converter: types.pdTx.MsgCreateIgp,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateIgp',
    },
  },
  MsgCreateIgpResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateIgpResponse',
      converter: types.pdTx.MsgCreateIgpResponse,
    },
  },
  MsgSetIgpOwner: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetIgpOwner',
      converter: types.pdTx.MsgSetIgpOwner,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetIgpOwner',
    },
  },
  MsgSetIgpOwnerResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetIgpOwnerResponse',
      converter: types.pdTx.MsgSetIgpOwnerResponse,
    },
  },
  MsgSetDestinationGasConfig: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetDestinationGasConfig',
      converter: types.pdTx.MsgSetDestinationGasConfig,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetDestinationGasConfig',
    },
  },
  MsgSetDestinationGasConfigResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetDestinationGasConfigResponse',
      converter: types.pdTx.MsgSetDestinationGasConfigResponse,
    },
  },
  MsgPayForGas: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgPayForGas',
      converter: types.pdTx.MsgPayForGas,
    },
    amino: {
      type: 'hyperlane/v1/MsgPayForGas',
    },
  },
  MsgPayForGasResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgPayForGasResponse',
      converter: types.pdTx.MsgPayForGasResponse,
    },
  },
  MsgClaim: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgClaim',
      converter: types.pdTx.MsgClaim,
    },
    amino: {
      type: 'hyperlane/v1/MsgClaim',
    },
  },
  MsgClaimResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgClaimResponse',
      converter: types.pdTx.MsgClaimResponse,
    },
  },
  MsgCreateMerkleTreeHook: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateMerkleTreeHook',
      converter: types.pdTx.MsgCreateMerkleTreeHook,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMerkleTreeHook',
    },
  },
  MsgCreateMerkleTreeHookResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateMerkleTreeHookResponse',
      converter: types.pdTx.MsgCreateMerkleTreeHookResponse,
    },
  },
  MsgCreateNoopHook: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateNoopHook',
      converter: types.pdTx.MsgCreateNoopHook,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateNoopHook',
    },
  },
  MsgCreateNoopHookResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateNoopHookResponse',
      converter: types.pdTx.MsgCreateNoopHookResponse,
    },
  },
  // Warp transactions
  MsgCreateCollateralToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateCollateralToken',
      converter: types.warpTx.MsgCreateCollateralToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgCreateCollateralToken',
    },
  },
  MsgCreateCollateralTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateCollateralTokenResponse',
      converter: types.warpTx.MsgCreateCollateralTokenResponse,
    },
  },
  MsgCreateSyntheticToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateSyntheticToken',
      converter: types.warpTx.MsgCreateSyntheticToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgCreateSyntheticToken',
    },
  },
  MsgCreateSyntheticTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateSyntheticTokenResponse',
      converter: types.warpTx.MsgCreateSyntheticTokenResponse,
    },
  },
  MsgSetToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgSetToken',
      converter: types.warpTx.MsgSetToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgSetToken',
    },
  },
  MsgSetTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgSetTokenResponse',
      converter: types.warpTx.MsgSetTokenResponse,
    },
  },
  MsgEnrollRemoteRouter: {
    proto: {
      type: '/hyperlane.warp.v1.MsgEnrollRemoteRouter',
      converter: types.warpTx.MsgEnrollRemoteRouter,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgEnrollRemoteRouter',
    },
  },
  MsgEnrollRemoteRouterResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgEnrollRemoteRouterResponse',
      converter: types.warpTx.MsgEnrollRemoteRouterResponse,
    },
  },
  MsgUnrollRemoteRouter: {
    proto: {
      type: '/hyperlane.warp.v1.MsgUnrollRemoteRouter',
      converter: types.warpTx.MsgUnrollRemoteRouter,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgUnrollRemoteRouter',
    },
  },
  MsgUnrollRemoteRouterResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgUnrollRemoteRouterResponse',
      converter: types.warpTx.MsgUnrollRemoteRouterResponse,
    },
  },
  MsgRemoteTransfer: {
    proto: {
      type: '/hyperlane.warp.v1.MsgRemoteTransfer',
      converter: types.warpTx.MsgRemoteTransfer,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgRemoteTransfer',
    },
  },
  MsgRemoteTransferResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgRemoteTransferResponse',
      converter: types.warpTx.MsgRemoteTransferResponse,
    },
  },
};
//# sourceMappingURL=registry.js.map
