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

export const createInterchainSecurityAminoConverter = () => {
  return {
    '/hyperlane.core.v1.MsgAnnounceValidator': {
      aminoType: 'hyperlane/MsgAnnounceValidator',
      toAmino: (
        msg: MsgAnnounceValidator,
      ): AminoMsgAnnounceValidator['value'] => ({
        validator: msg.validator,
        storage_location: msg.storage_location,
        signature: msg.signature,
        mailbox_id: msg.mailbox_id,
        creator: msg.creator,
      }),
      fromAmino: (
        msg: AminoMsgAnnounceValidator['value'],
      ): MsgAnnounceValidator => ({
        validator: msg.validator,
        storage_location: msg.storage_location,
        signature: msg.signature,
        mailbox_id: msg.mailbox_id,
        creator: msg.creator,
      }),
    },
    '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm': {
      aminoType: 'hyperlane/MsgCreateMerkleRootMultisigIsm',
      toAmino: (
        msg: MsgCreateMerkleRootMultisigIsm,
      ): AminoMsgCreateMerkleRootMultisigIsm['value'] => ({
        creator: msg.creator,
        validators: msg.validators,
        threshold: msg.threshold,
      }),
      fromAmino: (
        msg: AminoMsgCreateMerkleRootMultisigIsm['value'],
      ): MsgCreateMerkleRootMultisigIsm => ({
        creator: msg.creator,
        validators: msg.validators,
        threshold: msg.threshold,
      }),
    },
    '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm': {
      aminoType: 'hyperlane/MsgCreateMessageIdMultisigIsm',
      toAmino: (
        msg: MsgCreateMessageIdMultisigIsm,
      ): AminoMsgCreateMessageIdMultisigIsm['value'] => ({
        creator: msg.creator,
        validators: msg.validators,
        threshold: msg.threshold,
      }),
      fromAmino: (
        msg: AminoMsgCreateMessageIdMultisigIsm['value'],
      ): MsgCreateMessageIdMultisigIsm => ({
        creator: msg.creator,
        validators: msg.validators,
        threshold: msg.threshold,
      }),
    },
    '/hyperlane.core.v1.MsgCreateNoopIsm': {
      aminoType: 'hyperlane/MsgCreateNoopIsm',
      toAmino: (msg: MsgCreateNoopIsm): AminoMsgCreateNoopIsm['value'] => ({
        creator: msg.creator,
      }),
      fromAmino: (msg: AminoMsgCreateNoopIsm['value']): MsgCreateNoopIsm => ({
        creator: msg.creator,
      }),
    },
  };
};
