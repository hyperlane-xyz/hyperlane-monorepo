import { EncodeObject } from '@cosmjs/proto-signing';

import { pdTx } from '@hyperlane-xyz/cosmos-types';

import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../../registry.js';

export interface MsgCreateIgpEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateIgp.proto.type;
  readonly value: Partial<pdTx.MsgCreateIgp>;
}
export interface MsgSetIgpOwnerEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgSetIgpOwner.proto.type;
  readonly value: Partial<pdTx.MsgSetIgpOwner>;
}
export interface MsgSetDestinationGasConfigEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgSetDestinationGasConfig.proto.type;
  readonly value: Partial<pdTx.MsgSetDestinationGasConfig>;
}
export interface MsgPayForGasEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgPayForGas.proto.type;
  readonly value: Partial<pdTx.MsgPayForGas>;
}
export interface MsgClaimEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgClaim.proto.type;
  readonly value: Partial<pdTx.MsgClaim>;
}
export interface MsgCreateMerkleTreeHookEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateMerkleTreeHook.proto.type;
  readonly value: Partial<pdTx.MsgCreateMerkleTreeHook>;
}
export interface MsgCreateNoopHookEncodeObject extends EncodeObject {
  readonly typeUrl: typeof R.MsgCreateNoopHook.proto.type;
  readonly value: Partial<pdTx.MsgCreateNoopHook>;
}
//# sourceMappingURL=messages.d.ts.map
