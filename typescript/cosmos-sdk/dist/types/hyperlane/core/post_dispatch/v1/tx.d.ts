import _m0 from 'protobufjs/minimal';

import { Coin } from '../../../../cosmos/base/v1beta1/coin';

import { DestinationGasConfig } from './types';

export declare const protobufPackage = 'hyperlane.core.post_dispatch.v1';
/** MsgCreateIgp ... */
export interface MsgCreateIgp {
  /** owner is the message sender. */
  owner: string;
  /** denom */
  denom: string;
}
/** MsgCreateIgpResponse ... */
export interface MsgCreateIgpResponse {
  id: string;
}
/** MsgSetIgpOwner ... */
export interface MsgSetIgpOwner {
  /** owner is the message sender. */
  owner: string;
  /** igp_id */
  igp_id: string;
  /** new_owner */
  new_owner: string;
}
/** MsgCreateIgpResponse ... */
export interface MsgSetIgpOwnerResponse {}
/** MsgSetDestinationGasConfig ... */
export interface MsgSetDestinationGasConfig {
  /** owner ... */
  owner: string;
  /** igp_id ... */
  igp_id: string;
  /** destination_gas_config ... */
  destination_gas_config?: DestinationGasConfig | undefined;
}
/** MsgSetDestinationGasConfigResponse ... */
export interface MsgSetDestinationGasConfigResponse {}
/** MsgPayForGas ... */
export interface MsgPayForGas {
  /** sender ... */
  sender: string;
  /** igp_id ... */
  igp_id: string;
  /** message_id ... */
  message_id: string;
  /** destination_domain ... */
  destination_domain: number;
  /** gas_limit ... */
  gas_limit: string;
  /** amount ... */
  amount?: Coin | undefined;
}
/** MsgPayForGasResponse ... */
export interface MsgPayForGasResponse {}
/** MsgClaim ... */
export interface MsgClaim {
  /** sender ... */
  sender: string;
  /** igp_id ... */
  igp_id: string;
}
/** MsgClaimResponse ... */
export interface MsgClaimResponse {}
/** MsgMerkleTreeHook ... */
export interface MsgCreateMerkleTreeHook {
  /** sender ... */
  owner: string;
  mailbox_id: string;
}
/** MsgCreateMerkleTreeHookResponse ... */
export interface MsgCreateMerkleTreeHookResponse {
  id: string;
}
/** MsgMerkleTreeHook ... */
export interface MsgCreateNoopHook {
  /** sender ... */
  owner: string;
}
/** MsgCreateMerkleTreeHookResponse ... */
export interface MsgCreateNoopHookResponse {
  id: string;
}
export declare const MsgCreateIgp: {
  encode(message: MsgCreateIgp, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateIgp;
  fromJSON(object: any): MsgCreateIgp;
  toJSON(message: MsgCreateIgp): unknown;
  create<I extends Exact<DeepPartial<MsgCreateIgp>, I>>(base?: I): MsgCreateIgp;
  fromPartial<I extends Exact<DeepPartial<MsgCreateIgp>, I>>(
    object: I,
  ): MsgCreateIgp;
};
export declare const MsgCreateIgpResponse: {
  encode(message: MsgCreateIgpResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateIgpResponse;
  fromJSON(object: any): MsgCreateIgpResponse;
  toJSON(message: MsgCreateIgpResponse): unknown;
  create<I extends Exact<DeepPartial<MsgCreateIgpResponse>, I>>(
    base?: I,
  ): MsgCreateIgpResponse;
  fromPartial<I extends Exact<DeepPartial<MsgCreateIgpResponse>, I>>(
    object: I,
  ): MsgCreateIgpResponse;
};
export declare const MsgSetIgpOwner: {
  encode(message: MsgSetIgpOwner, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgSetIgpOwner;
  fromJSON(object: any): MsgSetIgpOwner;
  toJSON(message: MsgSetIgpOwner): unknown;
  create<I extends Exact<DeepPartial<MsgSetIgpOwner>, I>>(
    base?: I,
  ): MsgSetIgpOwner;
  fromPartial<I extends Exact<DeepPartial<MsgSetIgpOwner>, I>>(
    object: I,
  ): MsgSetIgpOwner;
};
export declare const MsgSetIgpOwnerResponse: {
  encode(_: MsgSetIgpOwnerResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgSetIgpOwnerResponse;
  fromJSON(_: any): MsgSetIgpOwnerResponse;
  toJSON(_: MsgSetIgpOwnerResponse): unknown;
  create<I extends Exact<DeepPartial<MsgSetIgpOwnerResponse>, I>>(
    base?: I,
  ): MsgSetIgpOwnerResponse;
  fromPartial<I extends Exact<DeepPartial<MsgSetIgpOwnerResponse>, I>>(
    _: I,
  ): MsgSetIgpOwnerResponse;
};
export declare const MsgSetDestinationGasConfig: {
  encode(message: MsgSetDestinationGasConfig, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgSetDestinationGasConfig;
  fromJSON(object: any): MsgSetDestinationGasConfig;
  toJSON(message: MsgSetDestinationGasConfig): unknown;
  create<I extends Exact<DeepPartial<MsgSetDestinationGasConfig>, I>>(
    base?: I,
  ): MsgSetDestinationGasConfig;
  fromPartial<I extends Exact<DeepPartial<MsgSetDestinationGasConfig>, I>>(
    object: I,
  ): MsgSetDestinationGasConfig;
};
export declare const MsgSetDestinationGasConfigResponse: {
  encode(
    _: MsgSetDestinationGasConfigResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgSetDestinationGasConfigResponse;
  fromJSON(_: any): MsgSetDestinationGasConfigResponse;
  toJSON(_: MsgSetDestinationGasConfigResponse): unknown;
  create<I extends Exact<DeepPartial<MsgSetDestinationGasConfigResponse>, I>>(
    base?: I,
  ): MsgSetDestinationGasConfigResponse;
  fromPartial<
    I extends Exact<DeepPartial<MsgSetDestinationGasConfigResponse>, I>,
  >(
    _: I,
  ): MsgSetDestinationGasConfigResponse;
};
export declare const MsgPayForGas: {
  encode(message: MsgPayForGas, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgPayForGas;
  fromJSON(object: any): MsgPayForGas;
  toJSON(message: MsgPayForGas): unknown;
  create<I extends Exact<DeepPartial<MsgPayForGas>, I>>(base?: I): MsgPayForGas;
  fromPartial<I extends Exact<DeepPartial<MsgPayForGas>, I>>(
    object: I,
  ): MsgPayForGas;
};
export declare const MsgPayForGasResponse: {
  encode(_: MsgPayForGasResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgPayForGasResponse;
  fromJSON(_: any): MsgPayForGasResponse;
  toJSON(_: MsgPayForGasResponse): unknown;
  create<I extends Exact<DeepPartial<MsgPayForGasResponse>, I>>(
    base?: I,
  ): MsgPayForGasResponse;
  fromPartial<I extends Exact<DeepPartial<MsgPayForGasResponse>, I>>(
    _: I,
  ): MsgPayForGasResponse;
};
export declare const MsgClaim: {
  encode(message: MsgClaim, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgClaim;
  fromJSON(object: any): MsgClaim;
  toJSON(message: MsgClaim): unknown;
  create<I extends Exact<DeepPartial<MsgClaim>, I>>(base?: I): MsgClaim;
  fromPartial<I extends Exact<DeepPartial<MsgClaim>, I>>(object: I): MsgClaim;
};
export declare const MsgClaimResponse: {
  encode(_: MsgClaimResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgClaimResponse;
  fromJSON(_: any): MsgClaimResponse;
  toJSON(_: MsgClaimResponse): unknown;
  create<I extends Exact<DeepPartial<MsgClaimResponse>, I>>(
    base?: I,
  ): MsgClaimResponse;
  fromPartial<I extends Exact<DeepPartial<MsgClaimResponse>, I>>(
    _: I,
  ): MsgClaimResponse;
};
export declare const MsgCreateMerkleTreeHook: {
  encode(message: MsgCreateMerkleTreeHook, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMerkleTreeHook;
  fromJSON(object: any): MsgCreateMerkleTreeHook;
  toJSON(message: MsgCreateMerkleTreeHook): unknown;
  create<I extends Exact<DeepPartial<MsgCreateMerkleTreeHook>, I>>(
    base?: I,
  ): MsgCreateMerkleTreeHook;
  fromPartial<I extends Exact<DeepPartial<MsgCreateMerkleTreeHook>, I>>(
    object: I,
  ): MsgCreateMerkleTreeHook;
};
export declare const MsgCreateMerkleTreeHookResponse: {
  encode(
    message: MsgCreateMerkleTreeHookResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMerkleTreeHookResponse;
  fromJSON(object: any): MsgCreateMerkleTreeHookResponse;
  toJSON(message: MsgCreateMerkleTreeHookResponse): unknown;
  create<I extends Exact<DeepPartial<MsgCreateMerkleTreeHookResponse>, I>>(
    base?: I,
  ): MsgCreateMerkleTreeHookResponse;
  fromPartial<I extends Exact<DeepPartial<MsgCreateMerkleTreeHookResponse>, I>>(
    object: I,
  ): MsgCreateMerkleTreeHookResponse;
};
export declare const MsgCreateNoopHook: {
  encode(message: MsgCreateNoopHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateNoopHook;
  fromJSON(object: any): MsgCreateNoopHook;
  toJSON(message: MsgCreateNoopHook): unknown;
  create<I extends Exact<DeepPartial<MsgCreateNoopHook>, I>>(
    base?: I,
  ): MsgCreateNoopHook;
  fromPartial<I extends Exact<DeepPartial<MsgCreateNoopHook>, I>>(
    object: I,
  ): MsgCreateNoopHook;
};
export declare const MsgCreateNoopHookResponse: {
  encode(message: MsgCreateNoopHookResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateNoopHookResponse;
  fromJSON(object: any): MsgCreateNoopHookResponse;
  toJSON(message: MsgCreateNoopHookResponse): unknown;
  create<I extends Exact<DeepPartial<MsgCreateNoopHookResponse>, I>>(
    base?: I,
  ): MsgCreateNoopHookResponse;
  fromPartial<I extends Exact<DeepPartial<MsgCreateNoopHookResponse>, I>>(
    object: I,
  ): MsgCreateNoopHookResponse;
};
/** Msg defines the module Msg service. */
export interface Msg {
  /** CreateIgp ... */
  CreateIgp(request: MsgCreateIgp): Promise<MsgCreateIgpResponse>;
  /** SetIgpOwner ... */
  SetIgpOwner(request: MsgSetIgpOwner): Promise<MsgSetIgpOwnerResponse>;
  /** SetDestinationGasConfig ... */
  SetDestinationGasConfig(
    request: MsgSetDestinationGasConfig,
  ): Promise<MsgSetDestinationGasConfigResponse>;
  /** PayForGas ... */
  PayForGas(request: MsgPayForGas): Promise<MsgPayForGasResponse>;
  /** Claim ... */
  Claim(request: MsgClaim): Promise<MsgClaimResponse>;
  /** CreateMerkleTreeHook ... */
  CreateMerkleTreeHook(
    request: MsgCreateMerkleTreeHook,
  ): Promise<MsgCreateMerkleTreeHookResponse>;
  /** CreateNoopHook ... */
  CreateNoopHook(
    request: MsgCreateNoopHook,
  ): Promise<MsgCreateNoopHookResponse>;
}
export declare const MsgServiceName = 'hyperlane.core.post_dispatch.v1.Msg';
export declare class MsgClientImpl implements Msg {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  CreateIgp(request: MsgCreateIgp): Promise<MsgCreateIgpResponse>;
  SetIgpOwner(request: MsgSetIgpOwner): Promise<MsgSetIgpOwnerResponse>;
  SetDestinationGasConfig(
    request: MsgSetDestinationGasConfig,
  ): Promise<MsgSetDestinationGasConfigResponse>;
  PayForGas(request: MsgPayForGas): Promise<MsgPayForGasResponse>;
  Claim(request: MsgClaim): Promise<MsgClaimResponse>;
  CreateMerkleTreeHook(
    request: MsgCreateMerkleTreeHook,
  ): Promise<MsgCreateMerkleTreeHookResponse>;
  CreateNoopHook(
    request: MsgCreateNoopHook,
  ): Promise<MsgCreateNoopHookResponse>;
}
interface Rpc {
  request(
    service: string,
    method: string,
    data: Uint8Array,
  ): Promise<Uint8Array>;
}
type Builtin =
  | Date
  | Function
  | Uint8Array
  | string
  | number
  | boolean
  | undefined;
export type DeepPartial<T> = T extends Builtin
  ? T
  : T extends globalThis.Array<infer U>
  ? globalThis.Array<DeepPartial<U>>
  : T extends ReadonlyArray<infer U>
  ? ReadonlyArray<DeepPartial<U>>
  : T extends {}
  ? {
      [K in keyof T]?: DeepPartial<T[K]>;
    }
  : Partial<T>;
type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin
  ? P
  : P & {
      [K in keyof P]: Exact<P[K], I[K]>;
    } & {
      [K in Exclude<keyof I, KeysOfUnion<P>>]: never;
    };
export {};
