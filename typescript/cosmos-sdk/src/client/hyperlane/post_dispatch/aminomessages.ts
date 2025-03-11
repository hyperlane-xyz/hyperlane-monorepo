import { AminoMsg, Coin } from '@cosmjs/amino';

import {
  MsgClaim,
  MsgCreateIgp,
  MsgCreateMerkleTreeHook,
  MsgCreateNoopHook,
  MsgPayForGas,
  MsgSetDestinationGasConfig,
  MsgSetIgpOwner,
} from '../../../types/hyperlane/core/post_dispatch/v1/tx';
import { DestinationGasConfig } from '../../../types/hyperlane/core/post_dispatch/v1/types';

export interface AminoMsgClaim extends AminoMsg {
  readonly type: 'hyperlane/MsgClaim';
  readonly value: {
    readonly sender: string;
    readonly igp_id: string;
  };
}

export interface AminoMsgCreateIgp extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateIgp';
  readonly value: {
    readonly owner: string;
    readonly denom: string;
  };
}

export interface AminoMsgCreateMerkleTreeHook extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateMerkleTreeHook';
  readonly value: {
    readonly owner: string;
    readonly mailbox_id: string;
  };
}

export interface AminoMsgCreateNoopHook extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateNoopHook';
  readonly value: {
    readonly owner: string;
  };
}

export interface AminoMsgPayForGas extends AminoMsg {
  readonly type: 'hyperlane/MsgPayForGas';
  readonly value: {
    readonly sender: string;
    readonly igp_id: string;
    readonly message_id: string;
    readonly destination_domain: number;
    readonly gas_limit: string;
    readonly amount: Coin;
  };
}

export interface AminoMsgSetDestinationGasConfig extends AminoMsg {
  readonly type: 'hyperlane/MsgSetDestinationGasConfig';
  readonly value: {
    readonly owner: string;
    readonly igp_id: string;
    readonly destination_gas_config?: DestinationGasConfig;
  };
}

export interface AminoMsgSetIgpOwner extends AminoMsg {
  readonly type: 'hyperlane/MsgSetIgpOwner';
  readonly value: {
    readonly owner: string;
    readonly igp_id: string;
    readonly new_owner: string;
  };
}

export const createPostDispatchAminoConverter = () => {
  return {
    '/hyperlane.core.v1.MsgClaim': {
      aminoType: 'hyperlane/MsgClaim',
      toAmino: (msg: MsgClaim): AminoMsgClaim['value'] => ({
        sender: msg.sender,
        igp_id: msg.igp_id,
      }),
      fromAmino: (msg: AminoMsgClaim['value']): MsgClaim => ({
        sender: msg.sender,
        igp_id: msg.igp_id,
      }),
    },
    '/hyperlane.core.v1.MsgCreateIgp': {
      aminoType: 'hyperlane/MsgCreateIgp',
      toAmino: (msg: MsgCreateIgp): AminoMsgCreateIgp['value'] => ({
        owner: msg.owner,
        denom: msg.denom,
      }),
      fromAmino: (msg: AminoMsgCreateIgp['value']): MsgCreateIgp => ({
        owner: msg.owner,
        denom: msg.denom,
      }),
    },
    '/hyperlane.core.v1.MsgCreateMerkleTreeHook': {
      aminoType: 'hyperlane/MsgCreateMerkleTreeHook',
      toAmino: (
        msg: MsgCreateMerkleTreeHook,
      ): AminoMsgCreateMerkleTreeHook['value'] => ({
        owner: msg.owner,
        mailbox_id: msg.mailbox_id,
      }),
      fromAmino: (
        msg: AminoMsgCreateMerkleTreeHook['value'],
      ): MsgCreateMerkleTreeHook => ({
        owner: msg.owner,
        mailbox_id: msg.mailbox_id,
      }),
    },
    '/hyperlane.core.v1.MsgCreateNoopHook': {
      aminoType: 'hyperlane/MsgCreateNoopHook',
      toAmino: (msg: MsgCreateNoopHook): AminoMsgCreateNoopHook['value'] => ({
        owner: msg.owner,
      }),
      fromAmino: (msg: AminoMsgCreateNoopHook['value']): MsgCreateNoopHook => ({
        owner: msg.owner,
      }),
    },
    '/hyperlane.core.v1.MsgPayForGas': {
      aminoType: 'hyperlane/MsgPayForGas',
      toAmino: (msg: MsgPayForGas): AminoMsgPayForGas['value'] => ({
        sender: msg.sender,
        igp_id: msg.igp_id,
        message_id: msg.message_id,
        destination_domain: msg.destination_domain,
        gas_limit: msg.gas_limit,
        amount: msg.amount!,
      }),
      fromAmino: (msg: AminoMsgPayForGas['value']): MsgPayForGas => ({
        sender: msg.sender,
        igp_id: msg.igp_id,
        message_id: msg.message_id,
        destination_domain: msg.destination_domain,
        gas_limit: msg.gas_limit,
        amount: msg.amount,
      }),
    },
    '/hyperlane.core.v1.MsgSetDestinationGasConfig': {
      aminoType: 'hyperlane/MsgSetDestinationGasConfig',
      toAmino: (
        msg: MsgSetDestinationGasConfig,
      ): AminoMsgSetDestinationGasConfig['value'] => ({
        owner: msg.owner,
        igp_id: msg.igp_id,
        destination_gas_config: msg.destination_gas_config,
      }),
      fromAmino: (
        msg: AminoMsgSetDestinationGasConfig['value'],
      ): MsgSetDestinationGasConfig => ({
        owner: msg.owner,
        igp_id: msg.igp_id,
        destination_gas_config: msg.destination_gas_config,
      }),
    },
    '/hyperlane.core.v1.MsgSetIgpOwner': {
      aminoType: 'hyperlane/MsgSetIgpOwner',
      toAmino: (msg: MsgSetIgpOwner): AminoMsgSetIgpOwner['value'] => ({
        owner: msg.owner,
        igp_id: msg.igp_id,
        new_owner: msg.new_owner,
      }),
      fromAmino: (msg: AminoMsgSetIgpOwner['value']): MsgSetIgpOwner => ({
        owner: msg.owner,
        igp_id: msg.igp_id,
        new_owner: msg.new_owner,
      }),
    },
  };
};
