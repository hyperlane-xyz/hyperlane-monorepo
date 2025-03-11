import { AminoMsg, Coin } from '@cosmjs/amino';

import {
  MsgCreateCollateralToken,
  MsgCreateSyntheticToken,
  MsgEnrollRemoteRouter,
  MsgRemoteTransfer,
  MsgSetToken,
  MsgUnrollRemoteRouter,
} from '../../../types/hyperlane/warp/v1/tx';
import { RemoteRouter } from '../../../types/hyperlane/warp/v1/types';

/** A high level transaction of the coin module */
export interface AminoMsgCreateCollateralToken extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateCollateralToken';
  readonly value: {
    readonly owner: string;
    readonly origin_mailbox: string;
    readonly origin_denom: string;
  };
}
export interface AminoMsgCreateSyntheticToken extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateSyntheticToken';
  readonly value: {
    readonly owner: string;
    readonly origin_mailbox: string;
  };
}
export interface AminoMsgEnrollRemoteRouter extends AminoMsg {
  readonly type: 'hyperlane/MsgEnrollRemoteRouter';
  readonly value: {
    readonly owner: string;
    readonly token_id: string;
    readonly remote_router: RemoteRouter;
  };
}
export interface AminoMsgRemoteTransfer extends AminoMsg {
  readonly type: 'hyperlane/MsgRemoteTransfer';
  readonly value: {
    readonly sender: string;
    readonly token_id: string;
    readonly destination_domain: number;
    readonly recipient: string;
    readonly amount: string;
    readonly custom_hook_id: string;
    readonly gas_limit: string;
    readonly max_fee: Coin;
    readonly custom_hook_metadata: string;
  };
}
export interface AminoMsgSetToken extends AminoMsg {
  readonly type: 'hyperlane/MsgSetToken';
  readonly value: {
    readonly owner: string;
    readonly token_id: string;
    readonly new_owner: string;
    readonly ism_id: string;
  };
}
export interface AminoMsgUnrollRemoteRouter extends AminoMsg {
  readonly type: 'hyperlane/MsgUnrollRemoteRouter';
  readonly value: {
    readonly owner: string;
    readonly token_id: string;
    readonly receiver_domain: number;
  };
}
export declare const createWarpAminoConverter: () => {
  '/hyperlane.warp.v1.MsgCreateCollateralToken': {
    aminoType: string;
    toAmino: (
      msg: MsgCreateCollateralToken,
    ) => AminoMsgCreateCollateralToken['value'];
    fromAmino: (
      msg: AminoMsgCreateCollateralToken['value'],
    ) => MsgCreateCollateralToken;
  };
  '/hyperlane.warp.v1.MsgCreateSyntheticToken': {
    aminoType: string;
    toAmino: (
      msg: MsgCreateSyntheticToken,
    ) => AminoMsgCreateSyntheticToken['value'];
    fromAmino: (
      msg: AminoMsgCreateSyntheticToken['value'],
    ) => MsgCreateSyntheticToken;
  };
  '/hyperlane.warp.v1.MsgEnrollRemoteRouter': {
    aminoType: string;
    toAmino: (
      msg: MsgEnrollRemoteRouter,
    ) => AminoMsgEnrollRemoteRouter['value'];
    fromAmino: (
      msg: AminoMsgEnrollRemoteRouter['value'],
    ) => MsgEnrollRemoteRouter;
  };
  '/hyperlane.warp.v1.MsgRemoteTransfer': {
    aminoType: string;
    toAmino: (msg: MsgRemoteTransfer) => AminoMsgRemoteTransfer['value'];
    fromAmino: (msg: AminoMsgRemoteTransfer['value']) => MsgRemoteTransfer;
  };
  '/hyperlane.warp.v1.MsgSetToken': {
    aminoType: string;
    toAmino: (msg: MsgSetToken) => AminoMsgSetToken['value'];
    fromAmino: (msg: AminoMsgSetToken['value']) => MsgSetToken;
  };
  '/hyperlane.warp.v1.MsgUnrollRemoteRouter': {
    aminoType: string;
    toAmino: (
      msg: MsgUnrollRemoteRouter,
    ) => AminoMsgUnrollRemoteRouter['value'];
    fromAmino: (
      msg: AminoMsgUnrollRemoteRouter['value'],
    ) => MsgUnrollRemoteRouter;
  };
};
