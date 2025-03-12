import {
  MsgAnnounceValidator,
  MsgCreateMerkleRootMultisigIsm,
  MsgCreateMessageIdMultisigIsm,
  MsgCreateNoopIsm,
} from '../../types/hyperlane/core/interchain_security/v1/tx';
import {
  MsgClaim,
  MsgCreateIgp,
  MsgCreateMerkleTreeHook,
  MsgCreateNoopHook,
  MsgPayForGas,
  MsgSetDestinationGasConfig,
  MsgSetIgpOwner,
} from '../../types/hyperlane/core/post_dispatch/v1/tx';
import {
  MsgCreateMailbox,
  MsgProcessMessage,
  MsgSetMailbox,
} from '../../types/hyperlane/core/v1/tx';
import {
  MsgCreateCollateralToken,
  MsgCreateSyntheticToken,
  MsgEnrollRemoteRouter,
  MsgRemoteTransfer,
  MsgSetToken,
  MsgUnrollRemoteRouter,
} from '../../types/hyperlane/warp/v1/tx';

export const REGISTRY: Record<string, any> = {
  // Core transactions
  '/hyperlane.core.v1.MsgCreateMailbox': MsgCreateMailbox,
  '/hyperlane.core.v1.MsgSetMailbox': MsgSetMailbox,
  '/hyperlane.core.v1.MsgProcessMessage': MsgProcessMessage,

  // Interchain security transactions
  '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm':
    MsgCreateMessageIdMultisigIsm,
  '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm':
    MsgCreateMerkleRootMultisigIsm,
  '/hyperlane.core.v1.MsgCreateNoopIsm': MsgCreateNoopIsm,
  '/hyperlane.core.v1.MsgAnnounceValidator': MsgAnnounceValidator,

  // Post dispatch transactions
  '/hyperlane.core.v1.MsgCreateIgp': MsgCreateIgp,
  '/hyperlane.core.v1.MsgSetIgpOwner': MsgSetIgpOwner,
  '/hyperlane.core.v1.MsgSetDestinationGasConfig': MsgSetDestinationGasConfig,
  '/hyperlane.core.v1.MsgPayForGas': MsgPayForGas,
  '/hyperlane.core.v1.MsgClaim': MsgClaim,
  '/hyperlane.core.v1.MsgCreateMerkleTreeHook': MsgCreateMerkleTreeHook,
  '/hyperlane.core.v1.MsgCreateNoopHook': MsgCreateNoopHook,

  // Warp transactions
  '/hyperlane.warp.v1.MsgCreateCollateralToken': MsgCreateCollateralToken,
  '/hyperlane.warp.v1.MsgCreateSyntheticToken': MsgCreateSyntheticToken,
  '/hyperlane.warp.v1.MsgSetToken': MsgSetToken,
  '/hyperlane.warp.v1.MsgEnrollRemoteRouter': MsgEnrollRemoteRouter,
  '/hyperlane.warp.v1.MsgUnrollRemoteRouter': MsgUnrollRemoteRouter,
  '/hyperlane.warp.v1.MsgRemoteTransfer': MsgRemoteTransfer,
};
