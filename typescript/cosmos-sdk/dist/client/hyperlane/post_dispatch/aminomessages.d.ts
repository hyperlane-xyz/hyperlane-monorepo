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
export declare const createPostDispatchAminoConverter: () => {
  '/hyperlane.core.v1.MsgClaim': {
    aminoType: string;
    toAmino: (msg: MsgClaim) => AminoMsgClaim['value'];
    fromAmino: (msg: AminoMsgClaim['value']) => MsgClaim;
  };
  '/hyperlane.core.v1.MsgCreateIgp': {
    aminoType: string;
    toAmino: (msg: MsgCreateIgp) => AminoMsgCreateIgp['value'];
    fromAmino: (msg: AminoMsgCreateIgp['value']) => MsgCreateIgp;
  };
  '/hyperlane.core.v1.MsgCreateMerkleTreeHook': {
    aminoType: string;
    toAmino: (
      msg: MsgCreateMerkleTreeHook,
    ) => AminoMsgCreateMerkleTreeHook['value'];
    fromAmino: (
      msg: AminoMsgCreateMerkleTreeHook['value'],
    ) => MsgCreateMerkleTreeHook;
  };
  '/hyperlane.core.v1.MsgCreateNoopHook': {
    aminoType: string;
    toAmino: (msg: MsgCreateNoopHook) => AminoMsgCreateNoopHook['value'];
    fromAmino: (msg: AminoMsgCreateNoopHook['value']) => MsgCreateNoopHook;
  };
  '/hyperlane.core.v1.MsgPayForGas': {
    aminoType: string;
    toAmino: (msg: MsgPayForGas) => AminoMsgPayForGas['value'];
    fromAmino: (msg: AminoMsgPayForGas['value']) => MsgPayForGas;
  };
  '/hyperlane.core.v1.MsgSetDestinationGasConfig': {
    aminoType: string;
    toAmino: (
      msg: MsgSetDestinationGasConfig,
    ) => AminoMsgSetDestinationGasConfig['value'];
    fromAmino: (
      msg: AminoMsgSetDestinationGasConfig['value'],
    ) => MsgSetDestinationGasConfig;
  };
  '/hyperlane.core.v1.MsgSetIgpOwner': {
    aminoType: string;
    toAmino: (msg: MsgSetIgpOwner) => AminoMsgSetIgpOwner['value'];
    fromAmino: (msg: AminoMsgSetIgpOwner['value']) => MsgSetIgpOwner;
  };
};
