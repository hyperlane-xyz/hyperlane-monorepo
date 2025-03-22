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

export interface MsgCreateIgpEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgCreateIgp';
  readonly value: Partial<MsgCreateIgp>;
}

export interface MsgSetIgpOwnerEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgSetIgpOwner';
  readonly value: Partial<MsgSetIgpOwner>;
}

export interface MsgSetDestinationGasConfigEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgSetDestinationGasConfig';
  readonly value: Partial<MsgSetDestinationGasConfig>;
}

export interface MsgPayForGasEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgPayForGas';
  readonly value: Partial<MsgPayForGas>;
}

export interface MsgClaimEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgClaim';
  readonly value: Partial<MsgClaim>;
}

export interface MsgCreateMerkleTreeHookEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgCreateMerkleTreeHook';
  readonly value: Partial<MsgCreateMerkleTreeHook>;
}

export interface MsgCreateNoopHookEncodeObject extends EncodeObject {
  readonly typeUrl: '/hyperlane.core.v1.MsgCreateNoopHook';
  readonly value: Partial<MsgCreateNoopHook>;
}
