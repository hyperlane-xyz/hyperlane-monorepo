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
      type: '/hyperlane.core.v1.MsgCreateMailbox' as const,
      converter: types.coreTx.MsgCreateMailbox,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMailbox' as const,
      converter: null,
    },
  },
  MsgCreateMailboxResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMailboxResponse' as const,
      converter: types.coreTx.MsgCreateMailboxResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgSetMailbox: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetMailbox' as const,
      converter: types.coreTx.MsgSetMailbox,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetMailbox' as const,
      converter: null,
    },
  },
  MsgSetMailboxResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetMailboxResponse' as const,
      converter: types.coreTx.MsgSetMailboxResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgProcessMessage: {
    proto: {
      type: '/hyperlane.core.v1.MsgProcessMessage' as const,
      converter: types.coreTx.MsgProcessMessage,
    },
    amino: {
      type: 'hyperlane/v1/MsgProcessMessage' as const,
      converter: null,
    },
  },
  MsgProcessMessageResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgProcessMessageResponse' as const,
      converter: types.coreTx.MsgProcessMessageResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },

  // Interchain security transactions
  MsgCreateMessageIdMultisigIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMessageIdMultisigIsm' as const,
      converter: types.isTx.MsgCreateMessageIdMultisigIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMessageIdMultisigIsm' as const,
      converter: null,
    },
  },
  MsgCreateMessageIdMultisigIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMessageIdMultisigIsmResponse' as const,
      converter: types.isTx.MsgCreateMessageIdMultisigIsmResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateMerkleRootMultisigIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMerkleRootMultisigIsm' as const,
      converter: types.isTx.MsgCreateMerkleRootMultisigIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMerkleRootMultisigIsm' as const,
      converter: null,
    },
  },
  MsgCreateMerkleRootMultisigIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMerkleRootMultisigIsmResponse' as const,
      converter: types.isTx.MsgCreateMerkleRootMultisigIsmResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateNoopIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateNoopIsm' as const,
      converter: types.isTx.MsgCreateNoopIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateNoopIsm' as const,
      converter: null,
    },
  },
  MsgCreateNoopIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateNoopIsmResponse' as const,
      converter: types.isTx.MsgCreateNoopIsmResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgAnnounceValidator: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgAnnounceValidator' as const,
      converter: types.isTx.MsgAnnounceValidator,
    },
    amino: {
      type: 'hyperlane/v1/MsgAnnounceValidator' as const,
      converter: null,
    },
  },
  MsgAnnounceValidatorResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgAnnounceValidatorResponse' as const,
      converter: types.isTx.MsgAnnounceValidatorResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },

  // Post dispatch transactions
  MsgCreateIgp: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateIgp' as const,
      converter: types.pdTx.MsgCreateIgp,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateIgp' as const,
      converter: null,
    },
  },
  MsgCreateIgpResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateIgpResponse' as const,
      converter: types.pdTx.MsgCreateIgpResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgSetIgpOwner: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetIgpOwner' as const,
      converter: types.pdTx.MsgSetIgpOwner,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetIgpOwner' as const,
      converter: null,
    },
  },
  MsgSetIgpOwnerResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetIgpOwnerResponse' as const,
      converter: types.pdTx.MsgSetIgpOwnerResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgSetDestinationGasConfig: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetDestinationGasConfig' as const,
      converter: types.pdTx.MsgSetDestinationGasConfig,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetDestinationGasConfig' as const,
      converter: null,
    },
  },
  MsgSetDestinationGasConfigResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetDestinationGasConfigResponse' as const,
      converter: types.pdTx.MsgSetDestinationGasConfigResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgPayForGas: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgPayForGas' as const,
      converter: types.pdTx.MsgPayForGas,
    },
    amino: {
      type: 'hyperlane/v1/MsgPayForGas' as const,
      converter: null,
    },
  },
  MsgPayForGasResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgPayForGasResponse' as const,
      converter: types.pdTx.MsgPayForGasResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgClaim: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgClaim' as const,
      converter: types.pdTx.MsgClaim,
    },
    amino: {
      type: 'hyperlane/v1/MsgClaim' as const,
      converter: null,
    },
  },
  MsgClaimResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgClaimResponse' as const,
      converter: types.pdTx.MsgClaimResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateMerkleTreeHook: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateMerkleTreeHook' as const,
      converter: types.pdTx.MsgCreateMerkleTreeHook,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMerkleTreeHook' as const,
      converter: null,
    },
  },
  MsgCreateMerkleTreeHookResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateMerkleTreeHookResponse' as const,
      converter: types.pdTx.MsgCreateMerkleTreeHookResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateNoopHook: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateNoopHook' as const,
      converter: types.pdTx.MsgCreateNoopHook,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateNoopHook' as const,
      converter: null,
    },
  },
  MsgCreateNoopHookResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateNoopHookResponse' as const,
      converter: types.pdTx.MsgCreateNoopHookResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },

  // Warp transactions
  MsgCreateCollateralToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateCollateralToken' as const,
      converter: types.warpTx.MsgCreateCollateralToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgCreateCollateralToken' as const,
      converter: null,
    },
  },
  MsgCreateCollateralTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateCollateralTokenResponse' as const,
      converter: types.warpTx.MsgCreateCollateralTokenResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateSyntheticToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateSyntheticToken' as const,
      converter: types.warpTx.MsgCreateSyntheticToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgCreateSyntheticToken' as const,
      converter: null,
    },
  },
  MsgCreateSyntheticTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateSyntheticTokenResponse' as const,
      converter: types.warpTx.MsgCreateSyntheticTokenResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgSetToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgSetToken' as const,
      converter: types.warpTx.MsgSetToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgSetToken' as const,
      converter: null,
    },
  },
  MsgSetTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgSetTokenResponse' as const,
      converter: types.warpTx.MsgSetTokenResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgEnrollRemoteRouter: {
    proto: {
      type: '/hyperlane.warp.v1.MsgEnrollRemoteRouter' as const,
      converter: types.warpTx.MsgEnrollRemoteRouter,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgEnrollRemoteRouter' as const,
      converter: null,
    },
  },
  MsgEnrollRemoteRouterResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgEnrollRemoteRouterResponse' as const,
      converter: types.warpTx.MsgEnrollRemoteRouterResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgUnrollRemoteRouter: {
    proto: {
      type: '/hyperlane.warp.v1.MsgUnrollRemoteRouter' as const,
      converter: types.warpTx.MsgUnrollRemoteRouter,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgUnrollRemoteRouter' as const,
      converter: null,
    },
  },
  MsgUnrollRemoteRouterResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgUnrollRemoteRouterResponse' as const,
      converter: types.warpTx.MsgUnrollRemoteRouterResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgRemoteTransfer: {
    proto: {
      type: '/hyperlane.warp.v1.MsgRemoteTransfer' as const,
      converter: types.warpTx.MsgRemoteTransfer,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgRemoteTransfer' as const,
      converter: null,
    },
  },
  MsgRemoteTransferResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgRemoteTransferResponse' as const,
      converter: types.warpTx.MsgRemoteTransferResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
};
