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
export declare const createCoreAminoConverter: () => {
  '/hyperlane.core.v1.MsgCreateMailbox': {
    aminoType: string;
    toAmino: (msg: MsgCreateMailbox) => AminoMsgCreateMailbox['value'];
    fromAmino: (msg: AminoMsgCreateMailbox['value']) => MsgCreateMailbox;
  };
  '/hyperlane.core.v1.MsgSetMailbox': {
    aminoType: string;
    toAmino: (msg: MsgSetMailbox) => AminoMsgSetMailbox['value'];
    fromAmino: (msg: AminoMsgSetMailbox['value']) => MsgSetMailbox;
  };
  '/hyperlane.core.v1.MsgProcessMessage': {
    aminoType: string;
    toAmino: (msg: MsgProcessMessage) => AminoMsgProcessMessage['value'];
    fromAmino: (msg: AminoMsgProcessMessage['value']) => MsgProcessMessage;
  };
};
