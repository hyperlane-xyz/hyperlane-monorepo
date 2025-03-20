import { EncodeObject } from '@cosmjs/proto-signing';

import {
  MsgCreateMailbox,
  MsgProcessMessage,
  MsgSetMailbox,
} from '../../../types/hyperlane/core/v1/tx.js';

export interface MsgCreateMailboxEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgCreateMailbox';
  readonly value: Partial<MsgCreateMailbox>;
}

export interface MsgSetMailboxEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgSetMailbox';
  readonly value: Partial<MsgSetMailbox>;
}

export interface MsgProcessMessageEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgProcessMessage';
  readonly value: Partial<MsgProcessMessage>;
}
