import { EncodeObject } from '@cosmjs/proto-signing';

import {
  MsgAnnounceValidator,
  MsgCreateMerkleRootMultisigIsm,
  MsgCreateMessageIdMultisigIsm,
  MsgCreateNoopIsm,
} from '../../../types/hyperlane/core/interchain_security/v1/tx.js';
import { REGISTRY } from '../../registry/index.js';

export interface MsgCreateMessageIdMultisigIsmEncodeObject
  extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateMessageIdMultisigIsm.proto.type;
  readonly value: Partial<MsgCreateMessageIdMultisigIsm>;
}

export interface MsgCreateMerkleRootMultisigIsmEncodeObject
  extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateMerkleRootMultisigIsm.proto.type;
  readonly value: Partial<MsgCreateMerkleRootMultisigIsm>;
}

export interface MsgCreateNoopIsmEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateNoopIsm.proto.type;
  readonly value: Partial<MsgCreateNoopIsm>;
}

export interface MsgAnnounceValidatorEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgAnnounceValidator.proto.type;
  readonly value: Partial<MsgAnnounceValidator>;
}
