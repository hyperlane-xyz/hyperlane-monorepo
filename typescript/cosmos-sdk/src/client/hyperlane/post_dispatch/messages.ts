import { EncodeObject } from '@cosmjs/proto-signing';

import {
  MsgClaim,
  MsgCreateIgp,
  MsgCreateMerkleTreeHook,
  MsgCreateNoopHook,
  MsgPayForGas,
  MsgSetDestinationGasConfig,
  MsgSetIgpOwner,
} from '../../../types/hyperlane/core/post_dispatch/v1/tx.js';
import { REGISTRY } from '../../registry/index.js';

export interface MsgCreateIgpEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateIgp.proto.type;
  readonly value: Partial<MsgCreateIgp>;
}

export interface MsgSetIgpOwnerEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgSetIgpOwner.proto.type;
  readonly value: Partial<MsgSetIgpOwner>;
}

export interface MsgSetDestinationGasConfigEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgSetDestinationGasConfig.proto.type;
  readonly value: Partial<MsgSetDestinationGasConfig>;
}

export interface MsgPayForGasEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgPayForGas.proto.type;
  readonly value: Partial<MsgPayForGas>;
}

export interface MsgClaimEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgClaim.proto.type;
  readonly value: Partial<MsgClaim>;
}

export interface MsgCreateMerkleTreeHookEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateMerkleTreeHook.proto.type;
  readonly value: Partial<MsgCreateMerkleTreeHook>;
}

export interface MsgCreateNoopHookEncodeObject extends EncodeObject {
  readonly typeUrl: typeof REGISTRY.MsgCreateNoopHook.proto.type;
  readonly value: Partial<MsgCreateNoopHook>;
}
