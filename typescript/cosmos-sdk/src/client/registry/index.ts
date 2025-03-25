import {
  MsgAnnounceValidator,
  MsgAnnounceValidatorResponse,
  MsgCreateMerkleRootMultisigIsm,
  MsgCreateMerkleRootMultisigIsmResponse,
  MsgCreateMessageIdMultisigIsm,
  MsgCreateMessageIdMultisigIsmResponse,
  MsgCreateNoopIsm,
  MsgCreateNoopIsmResponse,
} from '../../types/hyperlane/core/interchain_security/v1/tx.js';
import {
  MsgClaim,
  MsgClaimResponse,
  MsgCreateIgp,
  MsgCreateIgpResponse,
  MsgCreateMerkleTreeHook,
  MsgCreateMerkleTreeHookResponse,
  MsgCreateNoopHook,
  MsgCreateNoopHookResponse,
  MsgPayForGas,
  MsgPayForGasResponse,
  MsgSetDestinationGasConfig,
  MsgSetDestinationGasConfigResponse,
  MsgSetIgpOwner,
  MsgSetIgpOwnerResponse,
} from '../../types/hyperlane/core/post_dispatch/v1/tx.js';
import {
  MsgCreateMailbox,
  MsgCreateMailboxResponse,
  MsgProcessMessage,
  MsgProcessMessageResponse,
  MsgSetMailbox,
  MsgSetMailboxResponse,
} from '../../types/hyperlane/core/v1/tx.js';
import {
  MsgCreateCollateralToken,
  MsgCreateCollateralTokenResponse,
  MsgCreateSyntheticToken,
  MsgCreateSyntheticTokenResponse,
  MsgEnrollRemoteRouter,
  MsgEnrollRemoteRouterResponse,
  MsgRemoteTransfer,
  MsgRemoteTransferResponse,
  MsgSetToken,
  MsgSetTokenResponse,
  MsgUnrollRemoteRouter,
  MsgUnrollRemoteRouterResponse,
} from '../../types/hyperlane/warp/v1/tx.js';

// amino converters can be null by default since the
// converters for proto can be taken. In rare cases
// they can differ, in that instance the amino
// converters can be overriden here by adding the
// methods "toJSON" and "fromJSON".
export const REGISTRY = {
  // Core transactions
  MsgCreateMailbox: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMailbox' as const,
      converter: MsgCreateMailbox,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMailbox' as const,
      converter: null,
    },
  },
  MsgCreateMailboxResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMailboxResponse' as const,
      converter: MsgCreateMailboxResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgSetMailbox: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetMailbox' as const,
      converter: MsgSetMailbox,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetMailbox' as const,
      converter: null,
    },
  },
  MsgSetMailboxResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetMailboxResponse' as const,
      converter: MsgSetMailboxResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgProcessMessage: {
    proto: {
      type: '/hyperlane.core.v1.MsgProcessMessage' as const,
      converter: MsgProcessMessage,
    },
    amino: {
      type: 'hyperlane/v1/MsgProcessMessage' as const,
      converter: null,
    },
  },
  MsgProcessMessageResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgProcessMessageResponse' as const,
      converter: MsgProcessMessageResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },

  // Interchain security transactions
  MsgCreateMessageIdMultisigIsm: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm' as const,
      converter: MsgCreateMessageIdMultisigIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMessageIdMultisigIsm' as const,
      converter: null,
    },
  },
  MsgCreateMessageIdMultisigIsmResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsmResponse' as const,
      converter: MsgCreateMessageIdMultisigIsmResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateMerkleRootMultisigIsm: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm' as const,
      converter: MsgCreateMerkleRootMultisigIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMerkleRootMultisigIsm' as const,
      converter: null,
    },
  },
  MsgCreateMerkleRootMultisigIsmResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsmResponse' as const,
      converter: MsgCreateMerkleRootMultisigIsmResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateNoopIsm: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateNoopIsm' as const,
      converter: MsgCreateNoopIsm,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateNoopIsm' as const,
      converter: null,
    },
  },
  MsgCreateNoopIsmResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateNoopIsmResponse' as const,
      converter: MsgCreateNoopIsmResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgAnnounceValidator: {
    proto: {
      type: '/hyperlane.core.v1.MsgAnnounceValidator' as const,
      converter: MsgAnnounceValidator,
    },
    amino: {
      type: 'hyperlane/v1/MsgAnnounceValidator' as const,
      converter: null,
    },
  },
  MsgAnnounceValidatorResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgAnnounceValidatorResponse' as const,
      converter: MsgAnnounceValidatorResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },

  // Post dispatch transactions
  MsgCreateIgp: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateIgp' as const,
      converter: MsgCreateIgp,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateIgp' as const,
      converter: null,
    },
  },
  MsgCreateIgpResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateIgpResponse' as const,
      converter: MsgCreateIgpResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgSetIgpOwner: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetIgpOwner' as const,
      converter: MsgSetIgpOwner,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetIgpOwner' as const,
      converter: null,
    },
  },
  MsgSetIgpOwnerResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetIgpOwnerResponse' as const,
      converter: MsgSetIgpOwnerResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgSetDestinationGasConfig: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetDestinationGasConfig' as const,
      converter: MsgSetDestinationGasConfig,
    },
    amino: {
      type: 'hyperlane/v1/MsgSetDestinationGasConfig' as const,
      converter: null,
    },
  },
  MsgSetDestinationGasConfigResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgSetDestinationGasConfigResponse' as const,
      converter: MsgSetDestinationGasConfigResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgPayForGas: {
    proto: {
      type: '/hyperlane.core.v1.MsgPayForGas' as const,
      converter: MsgPayForGas,
    },
    amino: {
      type: 'hyperlane/v1/MsgPayForGas' as const,
      converter: null,
    },
  },
  MsgPayForGasResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgPayForGasResponse' as const,
      converter: MsgPayForGasResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgClaim: {
    proto: {
      type: '/hyperlane.core.v1.MsgClaim' as const,
      converter: MsgClaim,
    },
    amino: {
      type: 'hyperlane/v1/MsgClaim' as const,
      converter: null,
    },
  },
  MsgClaimResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgClaimResponse' as const,
      converter: MsgClaimResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateMerkleTreeHook: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMerkleTreeHook' as const,
      converter: MsgCreateMerkleTreeHook,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateMerkleTreeHook' as const,
      converter: null,
    },
  },
  MsgCreateMerkleTreeHookResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateMerkleTreeHookResponse' as const,
      converter: MsgCreateMerkleTreeHookResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateNoopHook: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateNoopHook' as const,
      converter: MsgCreateNoopHook,
    },
    amino: {
      type: 'hyperlane/v1/MsgCreateNoopHook' as const,
      converter: null,
    },
  },
  MsgCreateNoopHookResponse: {
    proto: {
      type: '/hyperlane.core.v1.MsgCreateNoopHookResponse' as const,
      converter: MsgCreateNoopHookResponse,
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
      converter: MsgCreateCollateralToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgCreateCollateralToken' as const,
      converter: null,
    },
  },
  MsgCreateCollateralTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateCollateralTokenResponse' as const,
      converter: MsgCreateCollateralTokenResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgCreateSyntheticToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateSyntheticToken' as const,
      converter: MsgCreateSyntheticToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgCreateSyntheticToken' as const,
      converter: null,
    },
  },
  MsgCreateSyntheticTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgCreateSyntheticTokenResponse' as const,
      converter: MsgCreateSyntheticTokenResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgSetToken: {
    proto: {
      type: '/hyperlane.warp.v1.MsgSetToken' as const,
      converter: MsgSetToken,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgSetToken' as const,
      converter: null,
    },
  },
  MsgSetTokenResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgSetTokenResponse' as const,
      converter: MsgSetTokenResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgEnrollRemoteRouter: {
    proto: {
      type: '/hyperlane.warp.v1.MsgEnrollRemoteRouter' as const,
      converter: MsgEnrollRemoteRouter,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgEnrollRemoteRouter' as const,
      converter: null,
    },
  },
  MsgEnrollRemoteRouterResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgEnrollRemoteRouterResponse' as const,
      converter: MsgEnrollRemoteRouterResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgUnrollRemoteRouter: {
    proto: {
      type: '/hyperlane.warp.v1.MsgUnrollRemoteRouter' as const,
      converter: MsgUnrollRemoteRouter,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgUnrollRemoteRouter' as const,
      converter: null,
    },
  },
  MsgUnrollRemoteRouterResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgUnrollRemoteRouterResponse' as const,
      converter: MsgUnrollRemoteRouterResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
  MsgRemoteTransfer: {
    proto: {
      type: '/hyperlane.warp.v1.MsgRemoteTransfer' as const,
      converter: MsgRemoteTransfer,
    },
    amino: {
      type: 'hyperlane/warp/v1/MsgRemoteTransfer' as const,
      converter: null,
    },
  },
  MsgRemoteTransferResponse: {
    proto: {
      type: '/hyperlane.warp.v1.MsgRemoteTransferResponse' as const,
      converter: MsgRemoteTransferResponse,
    },
    amino: {
      type: '',
      converter: null,
    },
  },
};
