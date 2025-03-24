import {
  MsgAnnounceValidator,
  MsgCreateMerkleRootMultisigIsm,
  MsgCreateMessageIdMultisigIsm,
  MsgCreateNoopIsm,
} from '../../types/hyperlane/core/interchain_security/v1/tx.js';
import {
  MsgClaim,
  MsgCreateIgp,
  MsgCreateMerkleTreeHook,
  MsgCreateNoopHook,
  MsgPayForGas,
  MsgSetDestinationGasConfig,
  MsgSetIgpOwner,
} from '../../types/hyperlane/core/post_dispatch/v1/tx.js';
import {
  MsgCreateMailbox,
  MsgProcessMessage,
  MsgSetMailbox,
} from '../../types/hyperlane/core/v1/tx.js';
import {
  MsgCreateCollateralToken,
  MsgCreateSyntheticToken,
  MsgEnrollRemoteRouter,
  MsgRemoteTransfer,
  MsgSetToken,
  MsgUnrollRemoteRouter,
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
};
