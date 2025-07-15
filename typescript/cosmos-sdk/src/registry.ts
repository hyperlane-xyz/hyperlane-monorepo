import * as types from '@hyperlane-xyz/cosmos-types';

type RawCosmosModuleMessageRegistry<T> = {
  [Key in keyof Omit<
    T,
    'protobufPackage' | 'MsgServiceName' | 'MsgClientImpl'
  >]: {
    proto: {
      type: string;
      converter: T[Key];
    };
    amino?: {
      type: string;
      converter?: T[Key];
    };
  };
};

type CoreCosmosModuleMesageRegistry = RawCosmosModuleMessageRegistry<
  typeof types.coreTx
>;
type IsmCosmosModuleMessafeRegistry = RawCosmosModuleMessageRegistry<
  typeof types.isTx
>;
type PostDispatchCosmosModuleMessageRegistry = RawCosmosModuleMessageRegistry<
  typeof types.pdTx
>;
type WarpTransactionCosmosModuleMessageRegistry =
  RawCosmosModuleMessageRegistry<typeof types.warpTx>;

type CosmosModuleMessageRegistry = CoreCosmosModuleMesageRegistry &
  IsmCosmosModuleMessafeRegistry &
  PostDispatchCosmosModuleMessageRegistry &
  WarpTransactionCosmosModuleMessageRegistry;

// amino converters can be null by default since the
// converters for proto can be taken. In rare cases
// they can differ, in that instance the amino
// converters can be overridden here by adding the
// methods "toJSON" and "fromJSON".
export const COSMOS_MODULE_MESSAGE_REGISTRY: CosmosModuleMessageRegistry = {
  // Core transactions
  MsgCreateMailbox: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMailbox' as const,
      converter: types.coreTx.MsgCreateMailbox,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMailbox' as const,
    },
  },
  MsgCreateMailboxResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMailboxResponse' as const,
      converter: types.coreTx.MsgCreateMailboxResponse,
    },
  },
  MsgSetMailbox: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetMailbox' as const,
      converter: types.coreTx.MsgSetMailbox,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetMailbox' as const,
    },
  },
  MsgSetMailboxResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetMailboxResponse' as const,
      converter: types.coreTx.MsgSetMailboxResponse,
    },
  },
  MsgProcessMessage: {
    proto: {
      type: '/hyperlane.core.v1.MsgProcessMessage' as const,
      converter: types.coreTx.MsgProcessMessage,
    },
    amino: {
      type: 'hyperlane/v1/MsgProcessMessage' as const,
    },
  },
  MsgProcessMessageResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgProcessMessageResponse' as const,
      converter: types.coreTx.MsgProcessMessageResponse,
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
    },
  },
  MsgCreateMessageIdMultisigIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMessageIdMultisigIsmResponse' as const,
      converter: types.isTx.MsgCreateMessageIdMultisigIsmResponse,
    },
  },
  MsgCreateMerkleRootMultisigIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMerkleRootMultisigIsm' as const,
      converter: types.isTx.MsgCreateMerkleRootMultisigIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMerkleRootMultisigIsm' as const,
    },
  },
  MsgCreateMerkleRootMultisigIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateMerkleRootMultisigIsmResponse' as const,
      converter: types.isTx.MsgCreateMerkleRootMultisigIsmResponse,
    },
  },
  MsgCreateNoopIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateNoopIsm' as const,
      converter: types.isTx.MsgCreateNoopIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateNoopIsm' as const,
    },
  },
  MsgCreateNoopIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateNoopIsmResponse' as const,
      converter: types.isTx.MsgCreateNoopIsmResponse,
    },
  },
  MsgAnnounceValidator: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgAnnounceValidator' as const,
      converter: types.isTx.MsgAnnounceValidator,
    },
    amino: {
      type: 'hyperlane/v1/MsgAnnounceValidator' as const,
    },
  },
  MsgAnnounceValidatorResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgAnnounceValidatorResponse' as const,
      converter: types.isTx.MsgAnnounceValidatorResponse,
    },
  },
  MsgCreateRoutingIsm: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateRoutingIsm' as const,
      converter: types.isTx.MsgCreateRoutingIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateRoutingIsm' as const,
    },
  },
  MsgCreateRoutingIsmResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgCreateRoutingIsmResponse' as const,
      converter: types.isTx.MsgCreateRoutingIsmResponse,
    },
  },
  MsgSetRoutingIsmDomain: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgSetRoutingIsmDomain' as const,
      converter: types.isTx.MsgSetRoutingIsmDomain,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetRoutingIsmDomain' as const,
    },
  },
  MsgSetRoutingIsmDomainResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgSetRoutingIsmDomainResponse' as const,
      converter: types.isTx.MsgSetRoutingIsmDomainResponse,
    },
  },
  MsgRemoveRoutingIsmDomain: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgRemoveRoutingIsmDomain' as const,
      converter: types.isTx.MsgRemoveRoutingIsmDomain,
    },
    amino: {
      type: 'hyperlane/v1/MsgRemoveRoutingIsmDomain' as const,
    },
  },
  MsgRemoveRoutingIsmDomainResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgRemoveRoutingIsmDomainResponse' as const,
      converter: types.isTx.MsgRemoveRoutingIsmDomainResponse,
    },
  },
  MsgUpdateRoutingIsmOwner: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgUpdateRoutingIsmOwner' as const,
      converter: types.isTx.MsgUpdateRoutingIsmOwner,
    },
    amino: {
      type: 'hyperlane/v1/MsgUpdateRoutingIsmOwner' as const,
    },
  },
  MsgUpdateRoutingIsmOwnerResponse: {
    proto: {
      type: '/hyperlane.core.interchain_security.v1.MsgUpdateRoutingIsmOwnerResponse' as const,
      converter: types.isTx.MsgUpdateRoutingIsmOwnerResponse,
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
    },
  },
  MsgCreateIgpResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateIgpResponse' as const,
      converter: types.pdTx.MsgCreateIgpResponse,
    },
  },
  MsgSetIgpOwner: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetIgpOwner' as const,
      converter: types.pdTx.MsgSetIgpOwner,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetIgpOwner' as const,
    },
  },
  MsgSetIgpOwnerResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetIgpOwnerResponse' as const,
      converter: types.pdTx.MsgSetIgpOwnerResponse,
    },
  },
  MsgSetDestinationGasConfig: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetDestinationGasConfig' as const,
      converter: types.pdTx.MsgSetDestinationGasConfig,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetDestinationGasConfig' as const,
    },
  },
  MsgSetDestinationGasConfigResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgSetDestinationGasConfigResponse' as const,
      converter: types.pdTx.MsgSetDestinationGasConfigResponse,
    },
  },
  MsgPayForGas: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgPayForGas' as const,
      converter: types.pdTx.MsgPayForGas,
    },
    amino: {
      type: 'hyperlane/v1/MsgPayForGas' as const,
    },
  },
  MsgPayForGasResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgPayForGasResponse' as const,
      converter: types.pdTx.MsgPayForGasResponse,
    },
  },
  MsgClaim: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgClaim' as const,
      converter: types.pdTx.MsgClaim,
    },
    amino: {
      type: 'hyperlane/v1/MsgClaim' as const,
    },
  },
  MsgClaimResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgClaimResponse' as const,
      converter: types.pdTx.MsgClaimResponse,
    },
  },
  MsgCreateMerkleTreeHook: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateMerkleTreeHook' as const,
      converter: types.pdTx.MsgCreateMerkleTreeHook,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMerkleTreeHook' as const,
    },
  },
  MsgCreateMerkleTreeHookResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateMerkleTreeHookResponse' as const,
      converter: types.pdTx.MsgCreateMerkleTreeHookResponse,
    },
  },
  MsgCreateNoopHook: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateNoopHook' as const,
      converter: types.pdTx.MsgCreateNoopHook,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateNoopHook' as const,
    },
  },
  MsgCreateNoopHookResponse: {
    proto: {
      type: '/hyperlane.core.post_dispatch.v1.MsgCreateNoopHookResponse' as const,
      converter: types.pdTx.MsgCreateNoopHookResponse,
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
    },
  },
  MsgCreateCollateralTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateCollateralTokenResponse' as const,
      converter: types.warpTx.MsgCreateCollateralTokenResponse,
    },
  },
  MsgCreateSyntheticToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateSyntheticToken' as const,
      converter: types.warpTx.MsgCreateSyntheticToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgCreateSyntheticToken' as const,
    },
  },
  MsgCreateSyntheticTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateSyntheticTokenResponse' as const,
      converter: types.warpTx.MsgCreateSyntheticTokenResponse,
    },
  },
  MsgSetToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgSetToken' as const,
      converter: types.warpTx.MsgSetToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgSetToken' as const,
    },
  },
  MsgSetTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgSetTokenResponse' as const,
      converter: types.warpTx.MsgSetTokenResponse,
    },
  },
  MsgEnrollRemoteRouter: {
    proto: {
      type: '/hyperlane.warp.v1.MsgEnrollRemoteRouter' as const,
      converter: types.warpTx.MsgEnrollRemoteRouter,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgEnrollRemoteRouter' as const,
    },
  },
  MsgEnrollRemoteRouterResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgEnrollRemoteRouterResponse' as const,
      converter: types.warpTx.MsgEnrollRemoteRouterResponse,
    },
  },
  MsgUnrollRemoteRouter: {
    proto: {
      type: '/hyperlane.warp.v1.MsgUnrollRemoteRouter' as const,
      converter: types.warpTx.MsgUnrollRemoteRouter,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgUnrollRemoteRouter' as const,
    },
  },
  MsgUnrollRemoteRouterResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgUnrollRemoteRouterResponse' as const,
      converter: types.warpTx.MsgUnrollRemoteRouterResponse,
    },
  },
  MsgRemoteTransfer: {
    proto: {
      type: '/hyperlane.warp.v1.MsgRemoteTransfer' as const,
      converter: types.warpTx.MsgRemoteTransfer,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgRemoteTransfer' as const,
    },
  },
  MsgRemoteTransferResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgRemoteTransferResponse' as const,
      converter: types.warpTx.MsgRemoteTransferResponse,
    },
  },
};
