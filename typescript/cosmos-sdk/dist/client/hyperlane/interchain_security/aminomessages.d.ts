import { AminoMsg } from '@cosmjs/amino';

import {
  MsgAnnounceValidator,
  MsgCreateMerkleRootMultisigIsm,
  MsgCreateMessageIdMultisigIsm,
  MsgCreateNoopIsm,
} from '../../../types/hyperlane/core/interchain_security/v1/tx';

export interface AminoMsgAnnounceValidator extends AminoMsg {
  readonly type: 'hyperlane/MsgAnnounceValidator';
  readonly value: {
    readonly validator: string;
    readonly storage_location: string;
    readonly signature: string;
    readonly mailbox_id: string;
    readonly creator: string;
  };
}
export interface AminoMsgCreateMerkleRootMultisigIsm extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateMerkleRootMultisigIsm';
  readonly value: {
    readonly creator: string;
    readonly validators: string[];
    readonly threshold: number;
  };
}
export interface AminoMsgCreateMessageIdMultisigIsm extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateMessageIdMultisigIsm';
  readonly value: {
    readonly creator: string;
    readonly validators: string[];
    readonly threshold: number;
  };
}
export interface AminoMsgCreateNoopIsm extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateNoopIsm';
  readonly value: {
    readonly creator: string;
  };
}
export declare const createInterchainSecurityAminoConverter: () => {
  '/hyperlane.core.v1.MsgAnnounceValidator': {
    aminoType: string;
    toAmino: (msg: MsgAnnounceValidator) => AminoMsgAnnounceValidator['value'];
    fromAmino: (
      msg: AminoMsgAnnounceValidator['value'],
    ) => MsgAnnounceValidator;
  };
  '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm': {
    aminoType: string;
    toAmino: (
      msg: MsgCreateMerkleRootMultisigIsm,
    ) => AminoMsgCreateMerkleRootMultisigIsm['value'];
    fromAmino: (
      msg: AminoMsgCreateMerkleRootMultisigIsm['value'],
    ) => MsgCreateMerkleRootMultisigIsm;
  };
  '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm': {
    aminoType: string;
    toAmino: (
      msg: MsgCreateMessageIdMultisigIsm,
    ) => AminoMsgCreateMessageIdMultisigIsm['value'];
    fromAmino: (
      msg: AminoMsgCreateMessageIdMultisigIsm['value'],
    ) => MsgCreateMessageIdMultisigIsm;
  };
  '/hyperlane.core.v1.MsgCreateNoopIsm': {
    aminoType: string;
    toAmino: (msg: MsgCreateNoopIsm) => AminoMsgCreateNoopIsm['value'];
    fromAmino: (msg: AminoMsgCreateNoopIsm['value']) => MsgCreateNoopIsm;
  };
};
