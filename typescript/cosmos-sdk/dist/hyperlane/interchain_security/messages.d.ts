import { EncodeObject } from '@cosmjs/proto-signing';

import { isTx } from '@hyperlane-xyz/cosmos-types';

import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../../registry.js';

export interface MsgCreateMessageIdMultisigIsmEncodeObject
  extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateMessageIdMultisigIsm.proto.type;
  readonly value: Partial<isTx.MsgCreateMessageIdMultisigIsm>;
}
export interface MsgCreateMerkleRootMultisigIsmEncodeObject
  extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateMerkleRootMultisigIsm.proto.type;
  readonly value: Partial<isTx.MsgCreateMerkleRootMultisigIsm>;
}
export interface MsgCreateNoopIsmEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateNoopIsm.proto.type;
  readonly value: Partial<isTx.MsgCreateNoopIsm>;
}
export interface MsgAnnounceValidatorEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgAnnounceValidator.proto.type;
  readonly value: Partial<isTx.MsgAnnounceValidator>;
}
//# sourceMappingURL=messages.d.ts.map
