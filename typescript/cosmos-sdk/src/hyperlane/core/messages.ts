import { EncodeObject } from '@cosmjs/proto-signing';

import { coreTx } from '@hyperlane-xyz/cosmos-types';

import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../../registry.js';

export interface MsgCreateMailboxEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateMailbox.proto.type;
  readonly value: Partial<coreTx.MsgCreateMailbox>;
}

export interface MsgSetMailboxEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgSetMailbox.proto.type;
  readonly value: Partial<coreTx.MsgSetMailbox>;
}

export interface MsgProcessMessageEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgProcessMessage.proto.type;
  readonly value: Partial<coreTx.MsgProcessMessage>;
}
