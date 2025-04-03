import { EncodeObject } from '@cosmjs/proto-signing';

import { warpTx } from '@hyperlane-xyz/cosmos-types';

import { REGISTRY } from '../../registry/index.js';

export interface MsgCreateCollateralTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateCollateralToken.proto.type;
  readonly value: Partial<warpTx.MsgCreateCollateralToken>;
}

export interface MsgCreateSyntheticTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateSyntheticToken.proto.type;
  readonly value: Partial<warpTx.MsgCreateSyntheticToken>;
}

export interface MsgSetTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgSetToken.proto.type;
  readonly value: Partial<warpTx.MsgSetToken>;
}

export interface MsgEnrollRemoteRouterEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgEnrollRemoteRouter.proto.type;
  readonly value: Partial<warpTx.MsgEnrollRemoteRouter>;
}

export interface MsgUnrollRemoteRouterEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgUnrollRemoteRouter.proto.type;
  readonly value: Partial<warpTx.MsgUnrollRemoteRouter>;
}

export interface MsgRemoteTransferEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgRemoteTransfer.proto.type;
  readonly value: Partial<warpTx.MsgRemoteTransfer>;
}
