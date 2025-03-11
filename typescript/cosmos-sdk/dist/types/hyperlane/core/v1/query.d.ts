import _m0 from 'protobufjs/minimal';

import {
  PageRequest,
  PageResponse,
} from '../../../cosmos/base/query/v1beta1/pagination';

import { Mailbox } from './types';

export declare const protobufPackage = 'hyperlane.core.v1';
/** QueryMailboxesRequest ... */
export interface QueryMailboxesRequest {
  /** pagination defines an optional pagination for the request. */
  pagination?: PageRequest | undefined;
}
/** QueryMailboxesResponse ... */
export interface QueryMailboxesResponse {
  mailboxes: Mailbox[];
  /** pagination defines the pagination in the response. */
  pagination?: PageResponse | undefined;
}
/** QueryMailboxRequest ... */
export interface QueryMailboxRequest {
  id: string;
}
/** QueryMailboxResponse ... */
export interface QueryMailboxResponse {
  mailbox?: Mailbox | undefined;
}
/** QueryDeliveredRequest ... */
export interface QueryDeliveredRequest {
  id: string;
  message_id: string;
}
/** QueryDeliveredResponse ... */
export interface QueryDeliveredResponse {
  delivered: boolean;
}
/** RecipientIsmRequest ... */
export interface RecipientIsmRequest {
  recipient: string;
}
/** RecipientIsmResponse ... */
export interface RecipientIsmResponse {
  ism_id: string;
}
/** QueryVerifyDryRunRequest ... */
export interface QueryVerifyDryRunRequest {
  ism_id: string;
  message: string;
  metadata: string;
}
/** QueryVerifyDryRunResponse ... */
export interface QueryVerifyDryRunResponse {
  verified: boolean;
}
export declare const QueryMailboxesRequest: {
  encode(message: QueryMailboxesRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryMailboxesRequest;
  fromJSON(object: any): QueryMailboxesRequest;
  toJSON(message: QueryMailboxesRequest): unknown;
  create<I extends Exact<DeepPartial<QueryMailboxesRequest>, I>>(
    base?: I,
  ): QueryMailboxesRequest;
  fromPartial<I extends Exact<DeepPartial<QueryMailboxesRequest>, I>>(
    object: I,
  ): QueryMailboxesRequest;
};
export declare const QueryMailboxesResponse: {
  encode(message: QueryMailboxesResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryMailboxesResponse;
  fromJSON(object: any): QueryMailboxesResponse;
  toJSON(message: QueryMailboxesResponse): unknown;
  create<I extends Exact<DeepPartial<QueryMailboxesResponse>, I>>(
    base?: I,
  ): QueryMailboxesResponse;
  fromPartial<I extends Exact<DeepPartial<QueryMailboxesResponse>, I>>(
    object: I,
  ): QueryMailboxesResponse;
};
export declare const QueryMailboxRequest: {
  encode(message: QueryMailboxRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryMailboxRequest;
  fromJSON(object: any): QueryMailboxRequest;
  toJSON(message: QueryMailboxRequest): unknown;
  create<I extends Exact<DeepPartial<QueryMailboxRequest>, I>>(
    base?: I,
  ): QueryMailboxRequest;
  fromPartial<I extends Exact<DeepPartial<QueryMailboxRequest>, I>>(
    object: I,
  ): QueryMailboxRequest;
};
export declare const QueryMailboxResponse: {
  encode(message: QueryMailboxResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryMailboxResponse;
  fromJSON(object: any): QueryMailboxResponse;
  toJSON(message: QueryMailboxResponse): unknown;
  create<I extends Exact<DeepPartial<QueryMailboxResponse>, I>>(
    base?: I,
  ): QueryMailboxResponse;
  fromPartial<I extends Exact<DeepPartial<QueryMailboxResponse>, I>>(
    object: I,
  ): QueryMailboxResponse;
};
export declare const QueryDeliveredRequest: {
  encode(message: QueryDeliveredRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryDeliveredRequest;
  fromJSON(object: any): QueryDeliveredRequest;
  toJSON(message: QueryDeliveredRequest): unknown;
  create<I extends Exact<DeepPartial<QueryDeliveredRequest>, I>>(
    base?: I,
  ): QueryDeliveredRequest;
  fromPartial<I extends Exact<DeepPartial<QueryDeliveredRequest>, I>>(
    object: I,
  ): QueryDeliveredRequest;
};
export declare const QueryDeliveredResponse: {
  encode(message: QueryDeliveredResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryDeliveredResponse;
  fromJSON(object: any): QueryDeliveredResponse;
  toJSON(message: QueryDeliveredResponse): unknown;
  create<I extends Exact<DeepPartial<QueryDeliveredResponse>, I>>(
    base?: I,
  ): QueryDeliveredResponse;
  fromPartial<I extends Exact<DeepPartial<QueryDeliveredResponse>, I>>(
    object: I,
  ): QueryDeliveredResponse;
};
export declare const RecipientIsmRequest: {
  encode(message: RecipientIsmRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): RecipientIsmRequest;
  fromJSON(object: any): RecipientIsmRequest;
  toJSON(message: RecipientIsmRequest): unknown;
  create<I extends Exact<DeepPartial<RecipientIsmRequest>, I>>(
    base?: I,
  ): RecipientIsmRequest;
  fromPartial<I extends Exact<DeepPartial<RecipientIsmRequest>, I>>(
    object: I,
  ): RecipientIsmRequest;
};
export declare const RecipientIsmResponse: {
  encode(message: RecipientIsmResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): RecipientIsmResponse;
  fromJSON(object: any): RecipientIsmResponse;
  toJSON(message: RecipientIsmResponse): unknown;
  create<I extends Exact<DeepPartial<RecipientIsmResponse>, I>>(
    base?: I,
  ): RecipientIsmResponse;
  fromPartial<I extends Exact<DeepPartial<RecipientIsmResponse>, I>>(
    object: I,
  ): RecipientIsmResponse;
};
export declare const QueryVerifyDryRunRequest: {
  encode(message: QueryVerifyDryRunRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryVerifyDryRunRequest;
  fromJSON(object: any): QueryVerifyDryRunRequest;
  toJSON(message: QueryVerifyDryRunRequest): unknown;
  create<I extends Exact<DeepPartial<QueryVerifyDryRunRequest>, I>>(
    base?: I,
  ): QueryVerifyDryRunRequest;
  fromPartial<I extends Exact<DeepPartial<QueryVerifyDryRunRequest>, I>>(
    object: I,
  ): QueryVerifyDryRunRequest;
};
export declare const QueryVerifyDryRunResponse: {
  encode(message: QueryVerifyDryRunResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryVerifyDryRunResponse;
  fromJSON(object: any): QueryVerifyDryRunResponse;
  toJSON(message: QueryVerifyDryRunResponse): unknown;
  create<I extends Exact<DeepPartial<QueryVerifyDryRunResponse>, I>>(
    base?: I,
  ): QueryVerifyDryRunResponse;
  fromPartial<I extends Exact<DeepPartial<QueryVerifyDryRunResponse>, I>>(
    object: I,
  ): QueryVerifyDryRunResponse;
};
/** Msg defines the module Msg service. */
export interface Query {
  /** Mailboxes ... */
  Mailboxes(request: QueryMailboxesRequest): Promise<QueryMailboxesResponse>;
  /** Mailbox ... */
  Mailbox(request: QueryMailboxRequest): Promise<QueryMailboxResponse>;
  /** Delivered ... */
  Delivered(request: QueryDeliveredRequest): Promise<QueryDeliveredResponse>;
  /**
   * RecipientIsm returns the recipient ISM ID for a registered application.
   *
   * The recipient is globally unique as every application ID registered on the
   * core module is unique. This means that one application cannot be registered
   * to two mailboxes, resulting in a mailbox-independent lookup.
   */
  RecipientIsm(request: RecipientIsmRequest): Promise<RecipientIsmResponse>;
  /** VerifyDryRun ... */
  VerifyDryRun(
    request: QueryVerifyDryRunRequest,
  ): Promise<QueryVerifyDryRunResponse>;
}
export declare const QueryServiceName = 'hyperlane.core.v1.Query';
export declare class QueryClientImpl implements Query {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  Mailboxes(request: QueryMailboxesRequest): Promise<QueryMailboxesResponse>;
  Mailbox(request: QueryMailboxRequest): Promise<QueryMailboxResponse>;
  Delivered(request: QueryDeliveredRequest): Promise<QueryDeliveredResponse>;
  RecipientIsm(request: RecipientIsmRequest): Promise<RecipientIsmResponse>;
  VerifyDryRun(
    request: QueryVerifyDryRunRequest,
  ): Promise<QueryVerifyDryRunResponse>;
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
