import { EncodeObject } from '@cosmjs/proto-signing';

import { pdTx } from '@hyperlane-xyz/cosmos-types';

import { REGISTRY } from '../../registry/index.js';

export interface MsgCreateIgpEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateIgp.proto.type;
  readonly value: Partial<pdTx.MsgCreateIgp>;
}

export interface MsgSetIgpOwnerEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgSetIgpOwner.proto.type;
  readonly value: Partial<pdTx.MsgSetIgpOwner>;
}

export interface MsgSetDestinationGasConfigEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgSetDestinationGasConfig.proto.type;
  readonly value: Partial<pdTx.MsgSetDestinationGasConfig>;
}

export interface MsgPayForGasEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgPayForGas.proto.type;
  readonly value: Partial<pdTx.MsgPayForGas>;
}

export interface MsgClaimEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgClaim.proto.type;
  readonly value: Partial<pdTx.MsgClaim>;
}

export interface MsgCreateMerkleTreeHookEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateMerkleTreeHook.proto.type;
  readonly value: Partial<pdTx.MsgCreateMerkleTreeHook>;
}

export interface MsgCreateNoopHookEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateNoopHook.proto.type;
  readonly value: Partial<pdTx.MsgCreateNoopHook>;
}
