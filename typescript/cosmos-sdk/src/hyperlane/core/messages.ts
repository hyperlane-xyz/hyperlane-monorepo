import { EncodeObject } from '@cosmjs/proto-signing';

import { coreTx } from '@hyperlane-xyz/cosmos-types';

import { REGISTRY } from '../../registry/index.js';

export interface MsgCreateMailboxEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateMailbox.proto.type;
  readonly value: Partial<coreTx.MsgCreateMailbox>;
}

export interface MsgSetMailboxEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgSetMailbox.proto.type;
  readonly value: Partial<coreTx.MsgSetMailbox>;
}

export interface MsgProcessMessageEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgProcessMessage.proto.type;
  readonly value: Partial<coreTx.MsgProcessMessage>;
}
