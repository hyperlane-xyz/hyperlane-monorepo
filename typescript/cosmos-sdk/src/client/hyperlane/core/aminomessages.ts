import { AminoMsg } from '@cosmjs/amino';

import {
  MsgCreateMailbox,
  MsgProcessMessage,
  MsgSetMailbox,
} from '../../../types/hyperlane/core/v1/tx';

export interface AminoMsgCreateMailbox extends AminoMsg {
  readonly type: 'hyperlane/MsgCreateMailbox';
  readonly value: {
    readonly owner: string;
    readonly default_ism: string;
    readonly default_hook: string;
    readonly local_domain: number;
    readonly required_hook: string;
  };
}

export interface AminoMsgSetMailbox extends AminoMsg {
  readonly type: 'hyperlane/MsgSetMailbox';
  readonly value: {
    readonly owner: string;
    readonly mailbox_id: string;
    readonly default_ism: string;
    readonly default_hook: string;
    readonly required_hook: string;
    readonly new_owner: string;
  };
}

export interface AminoMsgProcessMessage extends AminoMsg {
  readonly type: 'hyperlane/MsgProcessMessage';
  readonly value: {
    readonly mailbox_id: string;
    readonly relayer: string;
    readonly metadata: string;
    readonly message: string;
  };
}

export const createCoreAminoConverter = () => {
  return {
    '/hyperlane.core.v1.MsgCreateMailbox': {
      aminoType: 'hyperlane/MsgCreateMailbox',
      toAmino: (msg: MsgCreateMailbox): AminoMsgCreateMailbox['value'] => ({
        owner: msg.owner,
        local_domain: msg.local_domain,
        default_ism: msg.default_ism,
        default_hook: msg.default_hook,
        required_hook: msg.required_hook,
      }),
      fromAmino: (msg: AminoMsgCreateMailbox['value']): MsgCreateMailbox => ({
        owner: msg.owner,
        local_domain: msg.local_domain,
        default_ism: msg.default_ism,
        default_hook: msg.default_hook,
        required_hook: msg.required_hook,
      }),
    },
    '/hyperlane.core.v1.MsgSetMailbox': {
      aminoType: 'hyperlane/MsgSetMailbox',
      toAmino: (msg: MsgSetMailbox): AminoMsgSetMailbox['value'] => ({
        owner: msg.owner,
        mailbox_id: msg.mailbox_id,
        default_ism: msg.default_ism,
        default_hook: msg.default_hook,
        required_hook: msg.required_hook,
        new_owner: msg.new_owner,
      }),
      fromAmino: (msg: AminoMsgSetMailbox['value']): MsgSetMailbox => ({
        owner: msg.owner,
        mailbox_id: msg.mailbox_id,
        default_ism: msg.default_ism,
        default_hook: msg.default_hook,
        required_hook: msg.required_hook,
        new_owner: msg.new_owner,
      }),
    },
    '/hyperlane.core.v1.MsgProcessMessage': {
      aminoType: 'hyperlane/MsgProcessMessage',
      toAmino: (msg: MsgProcessMessage): AminoMsgProcessMessage['value'] => ({
        mailbox_id: msg.mailbox_id,
        relayer: msg.relayer,
        metadata: msg.metadata,
        message: msg.message,
      }),
      fromAmino: (msg: AminoMsgProcessMessage['value']): MsgProcessMessage => ({
        mailbox_id: msg.mailbox_id,
        relayer: msg.relayer,
        metadata: msg.metadata,
        message: msg.message,
      }),
    },
  };
};
