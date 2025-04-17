import { EncodeObject } from '@cosmjs/proto-signing';

import { warpTx } from '@hyperlane-xyz/cosmos-types';

import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../../registry.js';

export interface MsgCreateCollateralTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateCollateralToken.proto.type;
  readonly value: Partial<warpTx.MsgCreateCollateralToken>;
}

export interface MsgCreateSyntheticTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateSyntheticToken.proto.type;
  readonly value: Partial<warpTx.MsgCreateSyntheticToken>;
}

export interface MsgSetTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgSetToken.proto.type;
  readonly value: Partial<warpTx.MsgSetToken>;
}

export interface MsgEnrollRemoteRouterEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgEnrollRemoteRouter.proto.type;
  readonly value: Partial<warpTx.MsgEnrollRemoteRouter>;
}

export interface MsgUnrollRemoteRouterEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgUnrollRemoteRouter.proto.type;
  readonly value: Partial<warpTx.MsgUnrollRemoteRouter>;
}

export interface MsgRemoteTransferEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgRemoteTransfer.proto.type;
  readonly value: Partial<warpTx.MsgRemoteTransfer>;
}
