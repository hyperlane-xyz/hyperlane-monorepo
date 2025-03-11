import _m0 from 'protobufjs/minimal';

import {
  PageRequest,
  PageResponse,
} from '../../../../cosmos/base/query/v1beta1/pagination';
import { Any } from '../../../../google/protobuf/any';

export declare const protobufPackage = 'hyperlane.core.interchain_security.v1';
/** QueryIsmsRequest ... */
export interface QueryIsmsRequest {
  /** pagination defines an optional pagination for the request. */
  pagination?: PageRequest | undefined;
}
/** QueryIsmsResponse ... */
export interface QueryIsmsResponse {
  isms: Any[];
  /** pagination defines the pagination in the response. */
  pagination?: PageResponse | undefined;
}
/** QueryIsmRequest ... */
export interface QueryIsmRequest {
  id: string;
}
/** QueryIsmResponse ... */
export interface QueryIsmResponse {
  ism?: Any | undefined;
}
/** QueryAnnouncedStorageLocationsRequest ... */
export interface QueryAnnouncedStorageLocationsRequest {
  mailbox_id: string;
  validator_address: string;
}
/** QueryAnnouncedStorageLocationsResponse ... */
export interface QueryAnnouncedStorageLocationsResponse {
  storage_locations: string[];
}
/** QueryAnnouncedStorageLocationsRequest ... */
export interface QueryLatestAnnouncedStorageLocationRequest {
  mailbox_id: string;
  validator_address: string;
}
/** QueryAnnouncedStorageLocationsResponse ... */
export interface QueryLatestAnnouncedStorageLocationResponse {
  storage_location: string;
}
export declare const QueryIsmsRequest: {
  encode(message: QueryIsmsRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIsmsRequest;
  fromJSON(object: any): QueryIsmsRequest;
  toJSON(message: QueryIsmsRequest): unknown;
  create<I extends Exact<DeepPartial<QueryIsmsRequest>, I>>(
    base?: I,
  ): QueryIsmsRequest;
  fromPartial<I extends Exact<DeepPartial<QueryIsmsRequest>, I>>(
    object: I,
  ): QueryIsmsRequest;
};
export declare const QueryIsmsResponse: {
  encode(message: QueryIsmsResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIsmsResponse;
  fromJSON(object: any): QueryIsmsResponse;
  toJSON(message: QueryIsmsResponse): unknown;
  create<I extends Exact<DeepPartial<QueryIsmsResponse>, I>>(
    base?: I,
  ): QueryIsmsResponse;
  fromPartial<I extends Exact<DeepPartial<QueryIsmsResponse>, I>>(
    object: I,
  ): QueryIsmsResponse;
};
export declare const QueryIsmRequest: {
  encode(message: QueryIsmRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIsmRequest;
  fromJSON(object: any): QueryIsmRequest;
  toJSON(message: QueryIsmRequest): unknown;
  create<I extends Exact<DeepPartial<QueryIsmRequest>, I>>(
    base?: I,
  ): QueryIsmRequest;
  fromPartial<I extends Exact<DeepPartial<QueryIsmRequest>, I>>(
    object: I,
  ): QueryIsmRequest;
};
export declare const QueryIsmResponse: {
  encode(message: QueryIsmResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIsmResponse;
  fromJSON(object: any): QueryIsmResponse;
  toJSON(message: QueryIsmResponse): unknown;
  create<I extends Exact<DeepPartial<QueryIsmResponse>, I>>(
    base?: I,
  ): QueryIsmResponse;
  fromPartial<I extends Exact<DeepPartial<QueryIsmResponse>, I>>(
    object: I,
  ): QueryIsmResponse;
};
export declare const QueryAnnouncedStorageLocationsRequest: {
  encode(
    message: QueryAnnouncedStorageLocationsRequest,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryAnnouncedStorageLocationsRequest;
  fromJSON(object: any): QueryAnnouncedStorageLocationsRequest;
  toJSON(message: QueryAnnouncedStorageLocationsRequest): unknown;
  create<
    I extends Exact<DeepPartial<QueryAnnouncedStorageLocationsRequest>, I>,
  >(
    base?: I,
  ): QueryAnnouncedStorageLocationsRequest;
  fromPartial<
    I extends Exact<DeepPartial<QueryAnnouncedStorageLocationsRequest>, I>,
  >(
    object: I,
  ): QueryAnnouncedStorageLocationsRequest;
};
export declare const QueryAnnouncedStorageLocationsResponse: {
  encode(
    message: QueryAnnouncedStorageLocationsResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryAnnouncedStorageLocationsResponse;
  fromJSON(object: any): QueryAnnouncedStorageLocationsResponse;
  toJSON(message: QueryAnnouncedStorageLocationsResponse): unknown;
  create<
    I extends Exact<DeepPartial<QueryAnnouncedStorageLocationsResponse>, I>,
  >(
    base?: I,
  ): QueryAnnouncedStorageLocationsResponse;
  fromPartial<
    I extends Exact<DeepPartial<QueryAnnouncedStorageLocationsResponse>, I>,
  >(
    object: I,
  ): QueryAnnouncedStorageLocationsResponse;
};
export declare const QueryLatestAnnouncedStorageLocationRequest: {
  encode(
    message: QueryLatestAnnouncedStorageLocationRequest,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryLatestAnnouncedStorageLocationRequest;
  fromJSON(object: any): QueryLatestAnnouncedStorageLocationRequest;
  toJSON(message: QueryLatestAnnouncedStorageLocationRequest): unknown;
  create<
    I extends Exact<DeepPartial<QueryLatestAnnouncedStorageLocationRequest>, I>,
  >(
    base?: I,
  ): QueryLatestAnnouncedStorageLocationRequest;
  fromPartial<
    I extends Exact<DeepPartial<QueryLatestAnnouncedStorageLocationRequest>, I>,
  >(
    object: I,
  ): QueryLatestAnnouncedStorageLocationRequest;
};
export declare const QueryLatestAnnouncedStorageLocationResponse: {
  encode(
    message: QueryLatestAnnouncedStorageLocationResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryLatestAnnouncedStorageLocationResponse;
  fromJSON(object: any): QueryLatestAnnouncedStorageLocationResponse;
  toJSON(message: QueryLatestAnnouncedStorageLocationResponse): unknown;
  create<
    I extends Exact<
      DeepPartial<QueryLatestAnnouncedStorageLocationResponse>,
      I
    >,
  >(
    base?: I,
  ): QueryLatestAnnouncedStorageLocationResponse;
  fromPartial<
    I extends Exact<
      DeepPartial<QueryLatestAnnouncedStorageLocationResponse>,
      I
    >,
  >(
    object: I,
  ): QueryLatestAnnouncedStorageLocationResponse;
};
/** Msg defines the module Msg service. */
export interface Query {
  /** Isms ... */
  Isms(request: QueryIsmsRequest): Promise<QueryIsmsResponse>;
  /** Ism ... */
  Ism(request: QueryIsmRequest): Promise<QueryIsmResponse>;
  /** AnnouncedStorageLocations ... */
  AnnouncedStorageLocations(
    request: QueryAnnouncedStorageLocationsRequest,
  ): Promise<QueryAnnouncedStorageLocationsResponse>;
  /** LatestAnnouncedStorageLocation ... */
  LatestAnnouncedStorageLocation(
    request: QueryLatestAnnouncedStorageLocationRequest,
  ): Promise<QueryLatestAnnouncedStorageLocationResponse>;
}
export declare const QueryServiceName =
  'hyperlane.core.interchain_security.v1.Query';
export declare class QueryClientImpl implements Query {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  Isms(request: QueryIsmsRequest): Promise<QueryIsmsResponse>;
  Ism(request: QueryIsmRequest): Promise<QueryIsmResponse>;
  AnnouncedStorageLocations(
    request: QueryAnnouncedStorageLocationsRequest,
  ): Promise<QueryAnnouncedStorageLocationsResponse>;
  LatestAnnouncedStorageLocation(
    request: QueryLatestAnnouncedStorageLocationRequest,
  ): Promise<QueryLatestAnnouncedStorageLocationResponse>;
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
