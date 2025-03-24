import { EncodeObject } from '@cosmjs/proto-signing';

import {
  MsgCreateCollateralToken,
  MsgCreateSyntheticToken,
  MsgEnrollRemoteRouter,
  MsgRemoteTransfer,
  MsgSetToken,
  MsgUnrollRemoteRouter,
} from '../../../types/hyperlane/warp/v1/tx.js';
import { REGISTRY } from '../../registry/index.js';

export interface MsgCreateCollateralTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateCollateralToken.proto.type;
  readonly value: Partial<MsgCreateCollateralToken>;
}

export interface MsgCreateSyntheticTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateSyntheticToken.proto.type;
  readonly value: Partial<MsgCreateSyntheticToken>;
}

export interface MsgSetTokenEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgSetToken.proto.type;
  readonly value: Partial<MsgSetToken>;
}

export interface MsgEnrollRemoteRouterEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgEnrollRemoteRouter.proto.type;
  readonly value: Partial<MsgEnrollRemoteRouter>;
}

export interface MsgUnrollRemoteRouterEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgUnrollRemoteRouter.proto.type;
  readonly value: Partial<MsgUnrollRemoteRouter>;
}

export interface MsgRemoteTransferEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgRemoteTransfer.proto.type;
  readonly value: Partial<MsgRemoteTransfer>;
}
