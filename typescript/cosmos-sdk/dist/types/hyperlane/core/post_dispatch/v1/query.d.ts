import _m0 from 'protobufjs/minimal';

import {
  PageRequest,
  PageResponse,
} from '../../../../cosmos/base/query/v1beta1/pagination';
import { Coin } from '../../../../cosmos/base/v1beta1/coin';

import {
  DestinationGasConfig,
  InterchainGasPaymaster,
  NoopHook,
} from './types';

export declare const protobufPackage = 'hyperlane.core.post_dispatch.v1';
/** QueryIgpsRequest ... */
export interface QueryIgpsRequest {
  /** pagination defines an optional pagination for the request. */
  pagination?: PageRequest | undefined;
}
/** QueryIgpsResponse ... */
export interface QueryIgpsResponse {
  igps: InterchainGasPaymaster[];
  /** pagination defines the pagination in the response. */
  pagination?: PageResponse | undefined;
}
/** QueryIgpRequest ... */
export interface QueryIgpRequest {
  id: string;
}
/** QueryIgpResponse ... */
export interface QueryIgpResponse {
  igp?: InterchainGasPaymaster | undefined;
}
/** QueryDestinationGasConfigsRequest ... */
export interface QueryDestinationGasConfigsRequest {
  id: string;
  /** pagination defines an optional pagination for the request. */
  pagination?: PageRequest | undefined;
}
/** QueryDestinationGasConfigsResponse ... */
export interface QueryDestinationGasConfigsResponse {
  destination_gas_configs: DestinationGasConfig[];
  /** pagination defines the pagination in the response. */
  pagination?: PageResponse | undefined;
}
/** QueryQuoteGasPaymentRequest ... */
export interface QueryQuoteGasPaymentRequest {
  igp_id: string;
  destination_domain: string;
  gas_limit: string;
}
/** QueryQuoteGasPaymentResponse ... */
export interface QueryQuoteGasPaymentResponse {
  gas_payment: Coin[];
}
/** QueryCountRequest ... */
export interface QueryMerkleTreeHooks {
  pagination?: PageRequest | undefined;
}
/** QueryMerkleTreeHooksResponse ... */
export interface QueryMerkleTreeHooksResponse {
  merkle_tree_hooks: WrappedMerkleTreeHookResponse[];
  pagination?: PageResponse | undefined;
}
/** QueryMerkleTreeHook ... */
export interface QueryMerkleTreeHook {
  id: string;
}
/** QueryMerkleTreeHookResponse */
export interface QueryMerkleTreeHookResponse {
  merkle_tree_hook?: WrappedMerkleTreeHookResponse | undefined;
}
/** WrappedMerkleTreeHookResponse */
export interface WrappedMerkleTreeHookResponse {
  id: string;
  owner: string;
  mailbox_id: string;
  merkle_tree?: TreeResponse | undefined;
}
/** TreeResponse */
export interface TreeResponse {
  /** leafs ... */
  leafs: Uint8Array[];
  /** count ... */
  count: number;
  /** root ... */
  root: Uint8Array;
}
/** QueryNoopHookRequest ... */
export interface QueryNoopHookRequest {
  id: string;
}
/** QueryNoopHookResponse ... */
export interface QueryNoopHookResponse {
  noop_hook?: NoopHook | undefined;
}
/** QueryNoopHooksRequest ... */
export interface QueryNoopHooksRequest {
  pagination?: PageRequest | undefined;
}
/** QueryNoopHooksResponse ... */
export interface QueryNoopHooksResponse {
  noop_hooks: NoopHook[];
  pagination?: PageResponse | undefined;
}
export declare const QueryIgpsRequest: {
  encode(message: QueryIgpsRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIgpsRequest;
  fromJSON(object: any): QueryIgpsRequest;
  toJSON(message: QueryIgpsRequest): unknown;
  create<I extends Exact<DeepPartial<QueryIgpsRequest>, I>>(
    base?: I,
  ): QueryIgpsRequest;
  fromPartial<I extends Exact<DeepPartial<QueryIgpsRequest>, I>>(
    object: I,
  ): QueryIgpsRequest;
};
export declare const QueryIgpsResponse: {
  encode(message: QueryIgpsResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIgpsResponse;
  fromJSON(object: any): QueryIgpsResponse;
  toJSON(message: QueryIgpsResponse): unknown;
  create<I extends Exact<DeepPartial<QueryIgpsResponse>, I>>(
    base?: I,
  ): QueryIgpsResponse;
  fromPartial<I extends Exact<DeepPartial<QueryIgpsResponse>, I>>(
    object: I,
  ): QueryIgpsResponse;
};
export declare const QueryIgpRequest: {
  encode(message: QueryIgpRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIgpRequest;
  fromJSON(object: any): QueryIgpRequest;
  toJSON(message: QueryIgpRequest): unknown;
  create<I extends Exact<DeepPartial<QueryIgpRequest>, I>>(
    base?: I,
  ): QueryIgpRequest;
  fromPartial<I extends Exact<DeepPartial<QueryIgpRequest>, I>>(
    object: I,
  ): QueryIgpRequest;
};
export declare const QueryIgpResponse: {
  encode(message: QueryIgpResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIgpResponse;
  fromJSON(object: any): QueryIgpResponse;
  toJSON(message: QueryIgpResponse): unknown;
  create<I extends Exact<DeepPartial<QueryIgpResponse>, I>>(
    base?: I,
  ): QueryIgpResponse;
  fromPartial<I extends Exact<DeepPartial<QueryIgpResponse>, I>>(
    object: I,
  ): QueryIgpResponse;
};
export declare const QueryDestinationGasConfigsRequest: {
  encode(
    message: QueryDestinationGasConfigsRequest,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryDestinationGasConfigsRequest;
  fromJSON(object: any): QueryDestinationGasConfigsRequest;
  toJSON(message: QueryDestinationGasConfigsRequest): unknown;
  create<I extends Exact<DeepPartial<QueryDestinationGasConfigsRequest>, I>>(
    base?: I,
  ): QueryDestinationGasConfigsRequest;
  fromPartial<
    I extends Exact<DeepPartial<QueryDestinationGasConfigsRequest>, I>,
  >(
    object: I,
  ): QueryDestinationGasConfigsRequest;
};
export declare const QueryDestinationGasConfigsResponse: {
  encode(
    message: QueryDestinationGasConfigsResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryDestinationGasConfigsResponse;
  fromJSON(object: any): QueryDestinationGasConfigsResponse;
  toJSON(message: QueryDestinationGasConfigsResponse): unknown;
  create<I extends Exact<DeepPartial<QueryDestinationGasConfigsResponse>, I>>(
    base?: I,
  ): QueryDestinationGasConfigsResponse;
  fromPartial<
    I extends Exact<DeepPartial<QueryDestinationGasConfigsResponse>, I>,
  >(
    object: I,
  ): QueryDestinationGasConfigsResponse;
};
export declare const QueryQuoteGasPaymentRequest: {
  encode(message: QueryQuoteGasPaymentRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryQuoteGasPaymentRequest;
  fromJSON(object: any): QueryQuoteGasPaymentRequest;
  toJSON(message: QueryQuoteGasPaymentRequest): unknown;
  create<I extends Exact<DeepPartial<QueryQuoteGasPaymentRequest>, I>>(
    base?: I,
  ): QueryQuoteGasPaymentRequest;
  fromPartial<I extends Exact<DeepPartial<QueryQuoteGasPaymentRequest>, I>>(
    object: I,
  ): QueryQuoteGasPaymentRequest;
};
export declare const QueryQuoteGasPaymentResponse: {
  encode(
    message: QueryQuoteGasPaymentResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryQuoteGasPaymentResponse;
  fromJSON(object: any): QueryQuoteGasPaymentResponse;
  toJSON(message: QueryQuoteGasPaymentResponse): unknown;
  create<I extends Exact<DeepPartial<QueryQuoteGasPaymentResponse>, I>>(
    base?: I,
  ): QueryQuoteGasPaymentResponse;
  fromPartial<I extends Exact<DeepPartial<QueryQuoteGasPaymentResponse>, I>>(
    object: I,
  ): QueryQuoteGasPaymentResponse;
};
export declare const QueryMerkleTreeHooks: {
  encode(message: QueryMerkleTreeHooks, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryMerkleTreeHooks;
  fromJSON(object: any): QueryMerkleTreeHooks;
  toJSON(message: QueryMerkleTreeHooks): unknown;
  create<I extends Exact<DeepPartial<QueryMerkleTreeHooks>, I>>(
    base?: I,
  ): QueryMerkleTreeHooks;
  fromPartial<I extends Exact<DeepPartial<QueryMerkleTreeHooks>, I>>(
    object: I,
  ): QueryMerkleTreeHooks;
};
export declare const QueryMerkleTreeHooksResponse: {
  encode(
    message: QueryMerkleTreeHooksResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryMerkleTreeHooksResponse;
  fromJSON(object: any): QueryMerkleTreeHooksResponse;
  toJSON(message: QueryMerkleTreeHooksResponse): unknown;
  create<I extends Exact<DeepPartial<QueryMerkleTreeHooksResponse>, I>>(
    base?: I,
  ): QueryMerkleTreeHooksResponse;
  fromPartial<I extends Exact<DeepPartial<QueryMerkleTreeHooksResponse>, I>>(
    object: I,
  ): QueryMerkleTreeHooksResponse;
};
export declare const QueryMerkleTreeHook: {
  encode(message: QueryMerkleTreeHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryMerkleTreeHook;
  fromJSON(object: any): QueryMerkleTreeHook;
  toJSON(message: QueryMerkleTreeHook): unknown;
  create<I extends Exact<DeepPartial<QueryMerkleTreeHook>, I>>(
    base?: I,
  ): QueryMerkleTreeHook;
  fromPartial<I extends Exact<DeepPartial<QueryMerkleTreeHook>, I>>(
    object: I,
  ): QueryMerkleTreeHook;
};
export declare const QueryMerkleTreeHookResponse: {
  encode(message: QueryMerkleTreeHookResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryMerkleTreeHookResponse;
  fromJSON(object: any): QueryMerkleTreeHookResponse;
  toJSON(message: QueryMerkleTreeHookResponse): unknown;
  create<I extends Exact<DeepPartial<QueryMerkleTreeHookResponse>, I>>(
    base?: I,
  ): QueryMerkleTreeHookResponse;
  fromPartial<I extends Exact<DeepPartial<QueryMerkleTreeHookResponse>, I>>(
    object: I,
  ): QueryMerkleTreeHookResponse;
};
export declare const WrappedMerkleTreeHookResponse: {
  encode(
    message: WrappedMerkleTreeHookResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): WrappedMerkleTreeHookResponse;
  fromJSON(object: any): WrappedMerkleTreeHookResponse;
  toJSON(message: WrappedMerkleTreeHookResponse): unknown;
  create<I extends Exact<DeepPartial<WrappedMerkleTreeHookResponse>, I>>(
    base?: I,
  ): WrappedMerkleTreeHookResponse;
  fromPartial<I extends Exact<DeepPartial<WrappedMerkleTreeHookResponse>, I>>(
    object: I,
  ): WrappedMerkleTreeHookResponse;
};
export declare const TreeResponse: {
  encode(message: TreeResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): TreeResponse;
  fromJSON(object: any): TreeResponse;
  toJSON(message: TreeResponse): unknown;
  create<I extends Exact<DeepPartial<TreeResponse>, I>>(base?: I): TreeResponse;
  fromPartial<I extends Exact<DeepPartial<TreeResponse>, I>>(
    object: I,
  ): TreeResponse;
};
export declare const QueryNoopHookRequest: {
  encode(message: QueryNoopHookRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryNoopHookRequest;
  fromJSON(object: any): QueryNoopHookRequest;
  toJSON(message: QueryNoopHookRequest): unknown;
  create<I extends Exact<DeepPartial<QueryNoopHookRequest>, I>>(
    base?: I,
  ): QueryNoopHookRequest;
  fromPartial<I extends Exact<DeepPartial<QueryNoopHookRequest>, I>>(
    object: I,
  ): QueryNoopHookRequest;
};
export declare const QueryNoopHookResponse: {
  encode(message: QueryNoopHookResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryNoopHookResponse;
  fromJSON(object: any): QueryNoopHookResponse;
  toJSON(message: QueryNoopHookResponse): unknown;
  create<I extends Exact<DeepPartial<QueryNoopHookResponse>, I>>(
    base?: I,
  ): QueryNoopHookResponse;
  fromPartial<I extends Exact<DeepPartial<QueryNoopHookResponse>, I>>(
    object: I,
  ): QueryNoopHookResponse;
};
export declare const QueryNoopHooksRequest: {
  encode(message: QueryNoopHooksRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryNoopHooksRequest;
  fromJSON(object: any): QueryNoopHooksRequest;
  toJSON(message: QueryNoopHooksRequest): unknown;
  create<I extends Exact<DeepPartial<QueryNoopHooksRequest>, I>>(
    base?: I,
  ): QueryNoopHooksRequest;
  fromPartial<I extends Exact<DeepPartial<QueryNoopHooksRequest>, I>>(
    object: I,
  ): QueryNoopHooksRequest;
};
export declare const QueryNoopHooksResponse: {
  encode(message: QueryNoopHooksResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryNoopHooksResponse;
  fromJSON(object: any): QueryNoopHooksResponse;
  toJSON(message: QueryNoopHooksResponse): unknown;
  create<I extends Exact<DeepPartial<QueryNoopHooksResponse>, I>>(
    base?: I,
  ): QueryNoopHooksResponse;
  fromPartial<I extends Exact<DeepPartial<QueryNoopHooksResponse>, I>>(
    object: I,
  ): QueryNoopHooksResponse;
};
/** Msg defines the module Msg service. */
export interface Query {
  /** Igps ... */
  Igps(request: QueryIgpsRequest): Promise<QueryIgpsResponse>;
  /** Igp ... */
  Igp(request: QueryIgpRequest): Promise<QueryIgpResponse>;
  /** DestinationGasConfigs ... */
  DestinationGasConfigs(
    request: QueryDestinationGasConfigsRequest,
  ): Promise<QueryDestinationGasConfigsResponse>;
  /** QuoteGasPayment ... */
  QuoteGasPayment(
    request: QueryQuoteGasPaymentRequest,
  ): Promise<QueryQuoteGasPaymentResponse>;
  /** MerkleTreeHook ... */
  MerkleTreeHooks(
    request: QueryMerkleTreeHooks,
  ): Promise<QueryMerkleTreeHooksResponse>;
  /** MerkleTreeHook ... */
  MerkleTreeHook(
    request: QueryMerkleTreeHook,
  ): Promise<QueryMerkleTreeHookResponse>;
  /** NoopHooks ... */
  NoopHooks(request: QueryNoopHooksRequest): Promise<QueryNoopHooksResponse>;
  /** NoopHook ... */
  NoopHook(request: QueryNoopHookRequest): Promise<QueryNoopHookResponse>;
}
export declare const QueryServiceName = 'hyperlane.core.post_dispatch.v1.Query';
export declare class QueryClientImpl implements Query {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  Igps(request: QueryIgpsRequest): Promise<QueryIgpsResponse>;
  Igp(request: QueryIgpRequest): Promise<QueryIgpResponse>;
  DestinationGasConfigs(
    request: QueryDestinationGasConfigsRequest,
  ): Promise<QueryDestinationGasConfigsResponse>;
  QuoteGasPayment(
    request: QueryQuoteGasPaymentRequest,
  ): Promise<QueryQuoteGasPaymentResponse>;
  MerkleTreeHooks(
    request: QueryMerkleTreeHooks,
  ): Promise<QueryMerkleTreeHooksResponse>;
  MerkleTreeHook(
    request: QueryMerkleTreeHook,
  ): Promise<QueryMerkleTreeHookResponse>;
  NoopHooks(request: QueryNoopHooksRequest): Promise<QueryNoopHooksResponse>;
  NoopHook(request: QueryNoopHookRequest): Promise<QueryNoopHookResponse>;
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
