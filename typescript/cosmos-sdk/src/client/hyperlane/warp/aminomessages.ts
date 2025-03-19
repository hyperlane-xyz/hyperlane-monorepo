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
import { isNotEmpty } from '../../../utils';

/** A high level transaction of the coin module */
export interface AminoMsgCreateCollateralToken extends AminoMsg {
  readonly type: 'hyperlane/warp/v1/MsgCreateCollateralToken';
  readonly value: {
    readonly owner: string;
    readonly origin_mailbox: string;
    readonly origin_denom: string;
  };
}

export interface AminoMsgCreateSyntheticToken extends AminoMsg {
  readonly type: 'hyperlane/warp/v1/MsgCreateSyntheticToken';
  readonly value: {
    readonly owner: string;
    readonly origin_mailbox: string;
  };
}

export interface AminoMsgEnrollRemoteRouter extends AminoMsg {
  readonly type: 'hyperlane/warp/v1/MsgEnrollRemoteRouter';
  readonly value: {
    readonly owner: string;
    readonly token_id: string;
    readonly remote_router: RemoteRouter;
  };
}

export interface AminoMsgRemoteTransfer extends AminoMsg {
  readonly type: 'hyperlane/warp/v1/MsgRemoteTransfer';
  readonly value: {
    readonly sender: string;
    readonly token_id: string;
    readonly destination_domain: number;
    readonly recipient: string;
    readonly amount: string;
    readonly custom_hook_id?: string;
    readonly gas_limit?: string;
    readonly max_fee?: Coin;
    readonly custom_hook_metadata?: string;
  };
}

export interface AminoMsgSetToken extends AminoMsg {
  readonly type: 'hyperlane/warp/v1/MsgSetToken';
  readonly value: {
    readonly owner: string;
    readonly token_id: string;
    readonly new_owner: string;
    readonly ism_id: string;
  };
}

export interface AminoMsgUnrollRemoteRouter extends AminoMsg {
  readonly type: 'hyperlane/warp/v1/MsgUnrollRemoteRouter';
  readonly value: {
    readonly owner: string;
    readonly token_id: string;
    readonly receiver_domain: number;
  };
}

export const createWarpAminoConverter = () => {
  return {
    '/hyperlane.warp.v1.MsgCreateCollateralToken': {
      aminoType: 'hyperlane/warp/v1/MsgCreateCollateralToken',
      toAmino: (
        msg: MsgCreateCollateralToken,
      ): AminoMsgCreateCollateralToken['value'] => ({
        owner: msg.owner,
        origin_mailbox: msg.origin_mailbox,
        origin_denom: msg.origin_denom,
      }),
      fromAmino: (
        msg: AminoMsgCreateCollateralToken['value'],
      ): MsgCreateCollateralToken => ({
        owner: msg.owner,
        origin_mailbox: msg.origin_mailbox,
        origin_denom: msg.origin_denom,
      }),
    },
    '/hyperlane.warp.v1.MsgCreateSyntheticToken': {
      aminoType: 'hyperlane/warp/v1/MsgCreateSyntheticToken',
      toAmino: (
        msg: MsgCreateSyntheticToken,
      ): AminoMsgCreateSyntheticToken['value'] => ({
        owner: msg.owner,
        origin_mailbox: msg.origin_mailbox,
      }),
      fromAmino: (
        msg: AminoMsgCreateSyntheticToken['value'],
      ): MsgCreateSyntheticToken => ({
        owner: msg.owner,
        origin_mailbox: msg.origin_mailbox,
      }),
    },
    '/hyperlane.warp.v1.MsgEnrollRemoteRouter': {
      aminoType: 'hyperlane/warp/v1/MsgEnrollRemoteRouter',
      toAmino: (
        msg: MsgEnrollRemoteRouter,
      ): AminoMsgEnrollRemoteRouter['value'] => ({
        owner: msg.owner,
        token_id: msg.token_id,
        remote_router: msg.remote_router!,
      }),
      fromAmino: (
        msg: AminoMsgEnrollRemoteRouter['value'],
      ): MsgEnrollRemoteRouter => ({
        owner: msg.owner,
        token_id: msg.token_id,
        remote_router: msg.remote_router,
      }),
    },
    '/hyperlane.warp.v1.MsgRemoteTransfer': {
      aminoType: 'hyperlane/warp/v1/MsgRemoteTransfer',
      toAmino: (msg: MsgRemoteTransfer): AminoMsgRemoteTransfer['value'] => ({
        sender: msg.sender,
        token_id: msg.token_id,
        destination_domain: msg.destination_domain,
        recipient: msg.recipient,
        amount: msg.amount,
        ...(isNotEmpty(msg.custom_hook_id) && {
          custom_hook_id: msg.custom_hook_id,
        }),
        ...(isNotEmpty(msg.gas_limit) && {
          gas_limit: msg.gas_limit,
        }),
        ...(!!msg.max_fee && {
          max_fee: msg.max_fee,
        }),
        ...(isNotEmpty(msg.custom_hook_metadata) && {
          custom_hook_metadata: msg.custom_hook_metadata,
        }),
      }),
      fromAmino: (msg: AminoMsgRemoteTransfer['value']): MsgRemoteTransfer => ({
        sender: msg.sender,
        token_id: msg.token_id,
        destination_domain: msg.destination_domain,
        recipient: msg.recipient,
        amount: msg.amount,
        custom_hook_id: msg.custom_hook_id || '',
        gas_limit: msg.gas_limit || '',
        max_fee: msg.max_fee,
        custom_hook_metadata: msg.custom_hook_metadata || '',
      }),
    },
    '/hyperlane.warp.v1.MsgSetToken': {
      aminoType: 'hyperlane/warp/v1/MsgSetToken',
      toAmino: (msg: MsgSetToken): AminoMsgSetToken['value'] => ({
        owner: msg.owner,
        token_id: msg.token_id,
        new_owner: msg.new_owner,
        ism_id: msg.ism_id,
      }),
      fromAmino: (msg: AminoMsgSetToken['value']): MsgSetToken => ({
        owner: msg.owner,
        token_id: msg.token_id,
        new_owner: msg.new_owner,
        ism_id: msg.ism_id,
      }),
    },
    '/hyperlane.warp.v1.MsgUnrollRemoteRouter': {
      aminoType: 'hyperlane/warp/v1/MsgUnrollRemoteRouter',
      toAmino: (
        msg: MsgUnrollRemoteRouter,
      ): AminoMsgUnrollRemoteRouter['value'] => ({
        owner: msg.owner,
        token_id: msg.token_id,
        receiver_domain: msg.receiver_domain!,
      }),
      fromAmino: (
        msg: AminoMsgUnrollRemoteRouter['value'],
      ): MsgUnrollRemoteRouter => ({
        owner: msg.owner,
        token_id: msg.token_id,
        receiver_domain: msg.receiver_domain,
      }),
    },
  };
};
