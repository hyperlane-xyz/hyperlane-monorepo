import { EncodeObject } from '@cosmjs/proto-signing';

import {
  MsgCreateMailbox,
  MsgProcessMessage,
  MsgSetMailbox,
} from '../../../types/hyperlane/core/v1/tx.js';
import { REGISTRY } from '../../registry/index.js';

export interface MsgCreateMailboxEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateMailbox.proto.type;
  readonly value: Partial<MsgCreateMailbox>;
}

export interface MsgSetMailboxEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgSetMailbox.proto.type;
  readonly value: Partial<MsgSetMailbox>;
}

export interface MsgProcessMessageEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgProcessMessage.proto.type;
  readonly value: Partial<MsgProcessMessage>;
}
