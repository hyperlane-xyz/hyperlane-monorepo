import _m0 from 'protobufjs/minimal';

import {
  PageRequest,
  PageResponse,
} from '../../../cosmos/base/query/v1beta1/pagination';
import { Coin } from '../../../cosmos/base/v1beta1/coin';

import { HypTokenType, RemoteRouter } from './types';

export declare const protobufPackage = 'hyperlane.warp.v1';
/** QueryTokensRequest ... */
export interface QueryTokensRequest {
  pagination?: PageRequest | undefined;
}
/** QueryTokensResponse ... */
export interface QueryTokensResponse {
  /** params defines the parameters of the module. */
  tokens: WrappedHypToken[];
  /** pagination defines the pagination in the response. */
  pagination?: PageResponse | undefined;
}
/** QueryTokenRequest ... */
export interface QueryTokenRequest {
  id: string;
}
/** QueryTokenResponse ... */
export interface QueryTokenResponse {
  token?: WrappedHypToken | undefined;
}
/** / HypToken */
export interface WrappedHypToken {
  id: string;
  owner: string;
  token_type: HypTokenType;
  origin_mailbox: string;
  origin_denom: string;
  ism_id: string;
}
/** QueryBridgedSupplyRequest ... */
export interface QueryBridgedSupplyRequest {
  id: string;
}
/** QueryBridgedSupplyResponse ... */
export interface QueryBridgedSupplyResponse {
  bridged_supply?: Coin | undefined;
}
/** QueryRemoteRoutersRequest ... */
export interface QueryRemoteRoutersRequest {
  id: string;
  pagination?: PageRequest | undefined;
}
/** QueryRemoteRoutersResponse ... */
export interface QueryRemoteRoutersResponse {
  /** Remote Routers ... */
  remote_routers: RemoteRouter[];
  /** pagination defines the pagination in the response. */
  pagination?: PageResponse | undefined;
}
/** QueryQuoteRemoteTransferRequest ... */
export interface QueryQuoteRemoteTransferRequest {
  id: string;
  destination_domain: string;
}
/** QueryQuoteRemoteTransferResponse ... */
export interface QueryQuoteRemoteTransferResponse {
  gas_payment: Coin[];
}
export declare const QueryTokensRequest: {
  encode(message: QueryTokensRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryTokensRequest;
  fromJSON(object: any): QueryTokensRequest;
  toJSON(message: QueryTokensRequest): unknown;
  create<I extends Exact<DeepPartial<QueryTokensRequest>, I>>(
    base?: I,
  ): QueryTokensRequest;
  fromPartial<I extends Exact<DeepPartial<QueryTokensRequest>, I>>(
    object: I,
  ): QueryTokensRequest;
};
export declare const QueryTokensResponse: {
  encode(message: QueryTokensResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryTokensResponse;
  fromJSON(object: any): QueryTokensResponse;
  toJSON(message: QueryTokensResponse): unknown;
  create<I extends Exact<DeepPartial<QueryTokensResponse>, I>>(
    base?: I,
  ): QueryTokensResponse;
  fromPartial<I extends Exact<DeepPartial<QueryTokensResponse>, I>>(
    object: I,
  ): QueryTokensResponse;
};
export declare const QueryTokenRequest: {
  encode(message: QueryTokenRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryTokenRequest;
  fromJSON(object: any): QueryTokenRequest;
  toJSON(message: QueryTokenRequest): unknown;
  create<I extends Exact<DeepPartial<QueryTokenRequest>, I>>(
    base?: I,
  ): QueryTokenRequest;
  fromPartial<I extends Exact<DeepPartial<QueryTokenRequest>, I>>(
    object: I,
  ): QueryTokenRequest;
};
export declare const QueryTokenResponse: {
  encode(message: QueryTokenResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryTokenResponse;
  fromJSON(object: any): QueryTokenResponse;
  toJSON(message: QueryTokenResponse): unknown;
  create<I extends Exact<DeepPartial<QueryTokenResponse>, I>>(
    base?: I,
  ): QueryTokenResponse;
  fromPartial<I extends Exact<DeepPartial<QueryTokenResponse>, I>>(
    object: I,
  ): QueryTokenResponse;
};
export declare const WrappedHypToken: {
  encode(message: WrappedHypToken, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): WrappedHypToken;
  fromJSON(object: any): WrappedHypToken;
  toJSON(message: WrappedHypToken): unknown;
  create<I extends Exact<DeepPartial<WrappedHypToken>, I>>(
    base?: I,
  ): WrappedHypToken;
  fromPartial<I extends Exact<DeepPartial<WrappedHypToken>, I>>(
    object: I,
  ): WrappedHypToken;
};
export declare const QueryBridgedSupplyRequest: {
  encode(message: QueryBridgedSupplyRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryBridgedSupplyRequest;
  fromJSON(object: any): QueryBridgedSupplyRequest;
  toJSON(message: QueryBridgedSupplyRequest): unknown;
  create<I extends Exact<DeepPartial<QueryBridgedSupplyRequest>, I>>(
    base?: I,
  ): QueryBridgedSupplyRequest;
  fromPartial<I extends Exact<DeepPartial<QueryBridgedSupplyRequest>, I>>(
    object: I,
  ): QueryBridgedSupplyRequest;
};
export declare const QueryBridgedSupplyResponse: {
  encode(message: QueryBridgedSupplyResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryBridgedSupplyResponse;
  fromJSON(object: any): QueryBridgedSupplyResponse;
  toJSON(message: QueryBridgedSupplyResponse): unknown;
  create<I extends Exact<DeepPartial<QueryBridgedSupplyResponse>, I>>(
    base?: I,
  ): QueryBridgedSupplyResponse;
  fromPartial<I extends Exact<DeepPartial<QueryBridgedSupplyResponse>, I>>(
    object: I,
  ): QueryBridgedSupplyResponse;
};
export declare const QueryRemoteRoutersRequest: {
  encode(message: QueryRemoteRoutersRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryRemoteRoutersRequest;
  fromJSON(object: any): QueryRemoteRoutersRequest;
  toJSON(message: QueryRemoteRoutersRequest): unknown;
  create<I extends Exact<DeepPartial<QueryRemoteRoutersRequest>, I>>(
    base?: I,
  ): QueryRemoteRoutersRequest;
  fromPartial<I extends Exact<DeepPartial<QueryRemoteRoutersRequest>, I>>(
    object: I,
  ): QueryRemoteRoutersRequest;
};
export declare const QueryRemoteRoutersResponse: {
  encode(message: QueryRemoteRoutersResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryRemoteRoutersResponse;
  fromJSON(object: any): QueryRemoteRoutersResponse;
  toJSON(message: QueryRemoteRoutersResponse): unknown;
  create<I extends Exact<DeepPartial<QueryRemoteRoutersResponse>, I>>(
    base?: I,
  ): QueryRemoteRoutersResponse;
  fromPartial<I extends Exact<DeepPartial<QueryRemoteRoutersResponse>, I>>(
    object: I,
  ): QueryRemoteRoutersResponse;
};
export declare const QueryQuoteRemoteTransferRequest: {
  encode(
    message: QueryQuoteRemoteTransferRequest,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryQuoteRemoteTransferRequest;
  fromJSON(object: any): QueryQuoteRemoteTransferRequest;
  toJSON(message: QueryQuoteRemoteTransferRequest): unknown;
  create<I extends Exact<DeepPartial<QueryQuoteRemoteTransferRequest>, I>>(
    base?: I,
  ): QueryQuoteRemoteTransferRequest;
  fromPartial<I extends Exact<DeepPartial<QueryQuoteRemoteTransferRequest>, I>>(
    object: I,
  ): QueryQuoteRemoteTransferRequest;
};
export declare const QueryQuoteRemoteTransferResponse: {
  encode(
    message: QueryQuoteRemoteTransferResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryQuoteRemoteTransferResponse;
  fromJSON(object: any): QueryQuoteRemoteTransferResponse;
  toJSON(message: QueryQuoteRemoteTransferResponse): unknown;
  create<I extends Exact<DeepPartial<QueryQuoteRemoteTransferResponse>, I>>(
    base?: I,
  ): QueryQuoteRemoteTransferResponse;
  fromPartial<
    I extends Exact<DeepPartial<QueryQuoteRemoteTransferResponse>, I>,
  >(
    object: I,
  ): QueryQuoteRemoteTransferResponse;
};
/** Msg defines the module Msg service. */
export interface Query {
  /** Tokens ... */
  Tokens(request: QueryTokensRequest): Promise<QueryTokensResponse>;
  /** Token ... */
  Token(request: QueryTokenRequest): Promise<QueryTokenResponse>;
  /** BridgedSupply ... */
  BridgedSupply(
    request: QueryBridgedSupplyRequest,
  ): Promise<QueryBridgedSupplyResponse>;
  /** RemoteRouters ... */
  RemoteRouters(
    request: QueryRemoteRoutersRequest,
  ): Promise<QueryRemoteRoutersResponse>;
  /** QuoteRemoteTransfer ... */
  QuoteRemoteTransfer(
    request: QueryQuoteRemoteTransferRequest,
  ): Promise<QueryQuoteRemoteTransferResponse>;
}
export declare const QueryServiceName = 'hyperlane.warp.v1.Query';
export declare class QueryClientImpl implements Query {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  Tokens(request: QueryTokensRequest): Promise<QueryTokensResponse>;
  Token(request: QueryTokenRequest): Promise<QueryTokenResponse>;
  BridgedSupply(
    request: QueryBridgedSupplyRequest,
  ): Promise<QueryBridgedSupplyResponse>;
  RemoteRouters(
    request: QueryRemoteRoutersRequest,
  ): Promise<QueryRemoteRoutersResponse>;
  QuoteRemoteTransfer(
    request: QueryQuoteRemoteTransferRequest,
  ): Promise<QueryQuoteRemoteTransferResponse>;
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
