import { EncodeObject } from '@cosmjs/proto-signing';

import {
  MsgAnnounceValidator,
  MsgCreateMerkleRootMultisigIsm,
  MsgCreateMessageIdMultisigIsm,
  MsgCreateNoopIsm,
} from '../../../types/hyperlane/core/interchain_security/v1/tx.js';

export interface MsgCreateMessageIdMultisigIsmEncodeObject
  extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm';
  readonly value: Partial<MsgCreateMessageIdMultisigIsm>;
}

export interface MsgCreateMerkleRootMultisigIsmEncodeObject
  extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm';
  readonly value: Partial<MsgCreateMerkleRootMultisigIsm>;
}

export interface MsgCreateNoopIsmEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgCreateNoopIsm';
  readonly value: Partial<MsgCreateNoopIsm>;
}

export interface MsgAnnounceValidatorEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgAnnounceValidator';
  readonly value: Partial<MsgAnnounceValidator>;
}
