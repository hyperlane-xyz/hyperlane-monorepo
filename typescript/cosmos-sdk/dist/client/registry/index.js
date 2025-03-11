'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.REGISTRY = void 0;
const tx_1 = require('../../types/hyperlane/core/v1/tx');
const tx_2 = require('../../types/hyperlane/core/interchain_security/v1/tx');
const tx_3 = require('../../types/hyperlane/core/post_dispatch/v1/tx');
const tx_4 = require('../../types/hyperlane/warp/v1/tx');
exports.REGISTRY = {
  // Core transactions
  '/hyperlane.core.v1.MsgCreateMailbox': tx_1.MsgCreateMailbox,
  '/hyperlane.core.v1.MsgSetMailbox': tx_1.MsgSetMailbox,
  '/hyperlane.core.v1.MsgProcessMessage': tx_1.MsgProcessMessage,
  // Interchain security transactions
  '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm':
    tx_2.MsgCreateMessageIdMultisigIsm,
  '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm':
    tx_2.MsgCreateMerkleRootMultisigIsm,
  '/hyperlane.core.v1.MsgCreateNoopIsm': tx_2.MsgCreateNoopIsm,
  '/hyperlane.core.v1.MsgAnnounceValidator': tx_2.MsgAnnounceValidator,
  // Post dispatch transactions
  '/hyperlane.core.v1.MsgCreateIgp': tx_3.MsgCreateIgp,
  '/hyperlane.core.v1.MsgSetIgpOwner': tx_3.MsgSetIgpOwner,
  '/hyperlane.core.v1.MsgSetDestinationGasConfig':
    tx_3.MsgSetDestinationGasConfig,
  '/hyperlane.core.v1.MsgPayForGas': tx_3.MsgPayForGas,
  '/hyperlane.core.v1.MsgClaim': tx_3.MsgClaim,
  '/hyperlane.core.v1.MsgCreateMerkleTreeHook': tx_3.MsgCreateMerkleTreeHook,
  '/hyperlane.core.v1.MsgCreateNoopHook': tx_3.MsgCreateNoopHook,
  // Warp transactions
  '/hyperlane.warp.v1.MsgCreateCollateralToken': tx_4.MsgCreateCollateralToken,
  '/hyperlane.warp.v1.MsgCreateSyntheticToken': tx_4.MsgCreateSyntheticToken,
  '/hyperlane.warp.v1.MsgSetToken': tx_4.MsgSetToken,
  '/hyperlane.warp.v1.MsgEnrollRemoteRouter': tx_4.MsgEnrollRemoteRouter,
  '/hyperlane.warp.v1.MsgUnrollRemoteRouter': tx_4.MsgUnrollRemoteRouter,
  '/hyperlane.warp.v1.MsgRemoteTransfer': tx_4.MsgRemoteTransfer,
};
//# sourceMappingURL=index.js.map
