import { EncodeObject } from '@cosmjs/proto-signing';

import {
  MsgCreateCollateralToken,
  MsgCreateSyntheticToken,
  MsgEnrollRemoteRouter,
  MsgRemoteTransfer,
  MsgSetToken,
  MsgUnrollRemoteRouter,
} from '../../../types/hyperlane/warp/v1/tx';

export interface MsgCreateCollateralTokenEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.warp.v1.MsgCreateCollateralToken';
  readonly value: Partial<MsgCreateCollateralToken>;
}

export interface MsgCreateSyntheticTokenEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.warp.v1.MsgCreateSyntheticToken';
  readonly value: Partial<MsgCreateSyntheticToken>;
}

export interface MsgSetTokenEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.warp.v1.MsgSetToken';
  readonly value: Partial<MsgSetToken>;
}

export interface MsgEnrollRemoteRouterEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.warp.v1.MsgEnrollRemoteRouter';
  readonly value: Partial<MsgEnrollRemoteRouter>;
}

export interface MsgUnrollRemoteRouterEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.warp.v1.MsgUnrollRemoteRouter';
  readonly value: Partial<MsgUnrollRemoteRouter>;
}

export interface MsgRemoteTransferEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.warp.v1.MsgRemoteTransfer';
  readonly value: Partial<MsgRemoteTransfer>;
}
