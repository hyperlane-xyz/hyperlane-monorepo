import { EncodeObject } from '@cosmjs/proto-signing';

import { isTx } from '@hyperlane-xyz/cosmos-types';

import { REGISTRY } from '../../registry/index.js';

export interface MsgCreateMessageIdMultisigIsmEncodeObject
  extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateMessageIdMultisigIsm.proto.type;
  readonly value: Partial<isTx.MsgCreateMessageIdMultisigIsm>;
}

export interface MsgCreateMerkleRootMultisigIsmEncodeObject
  extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateMerkleRootMultisigIsm.proto.type;
  readonly value: Partial<isTx.MsgCreateMerkleRootMultisigIsm>;
}

export interface MsgCreateNoopIsmEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateNoopIsm.proto.type;
  readonly value: Partial<isTx.MsgCreateNoopIsm>;
}

export interface MsgAnnounceValidatorEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgAnnounceValidator.proto.type;
  readonly value: Partial<isTx.MsgAnnounceValidator>;
}
