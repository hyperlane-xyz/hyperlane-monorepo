import _m0 from 'protobufjs/minimal.js';

import {
  PageRequest,
  PageResponse,
} from '../../../../cosmos/base/query/v1beta1/pagination.js';
import { Any } from '../../../../google/protobuf/any.js';

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
/** QueryLatestAnnouncedStorageLocationRequest ... */
export interface QueryLatestAnnouncedStorageLocationRequest {
  mailbox_id: string;
  validator_address: string;
}
/** QueryLatestAnnouncedStorageLocationResponse ... */
export interface QueryLatestAnnouncedStorageLocationResponse {
  storage_location: string;
}
export declare const QueryIsmsRequest: {
  encode(message: QueryIsmsRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIsmsRequest;
  fromJSON(object: any): QueryIsmsRequest;
  toJSON(message: QueryIsmsRequest): unknown;
  create<
    I extends {
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K in Exclude<keyof I['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'pagination'>]: never },
  >(
    base?: I | undefined,
  ): QueryIsmsRequest;
  fromPartial<
    I_1 extends {
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'pagination'>]: never },
  >(
    object: I_1,
  ): QueryIsmsRequest;
};
export declare const QueryIsmsResponse: {
  encode(message: QueryIsmsResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIsmsResponse;
  fromJSON(object: any): QueryIsmsResponse;
  toJSON(message: QueryIsmsResponse): unknown;
  create<
    I extends {
      isms?:
        | {
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      isms?:
        | ({
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          }[] &
            ({
              type_url?: string | undefined;
              value?: Uint8Array | undefined;
            } & {
              type_url?: string | undefined;
              value?: Uint8Array | undefined;
            } & {
              [K in Exclude<keyof I['isms'][number], keyof Any>]: never;
            })[] & {
              [K_1 in Exclude<
                keyof I['isms'],
                keyof {
                  type_url?: string | undefined;
                  value?: Uint8Array | undefined;
                }[]
              >]: never;
            })
        | undefined;
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_2 in Exclude<keyof I['pagination'], keyof PageResponse>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I, keyof QueryIsmsResponse>]: never },
  >(
    base?: I | undefined,
  ): QueryIsmsResponse;
  fromPartial<
    I_1 extends {
      isms?:
        | {
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      isms?:
        | ({
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          }[] &
            ({
              type_url?: string | undefined;
              value?: Uint8Array | undefined;
            } & {
              type_url?: string | undefined;
              value?: Uint8Array | undefined;
            } & {
              [K_4 in Exclude<keyof I_1['isms'][number], keyof Any>]: never;
            })[] & {
              [K_5 in Exclude<
                keyof I_1['isms'],
                keyof {
                  type_url?: string | undefined;
                  value?: Uint8Array | undefined;
                }[]
              >]: never;
            })
        | undefined;
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_6 in Exclude<
              keyof I_1['pagination'],
              keyof PageResponse
            >]: never;
          })
        | undefined;
    } & { [K_7 in Exclude<keyof I_1, keyof QueryIsmsResponse>]: never },
  >(
    object: I_1,
  ): QueryIsmsResponse;
};
export declare const QueryIsmRequest: {
  encode(message: QueryIsmRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIsmRequest;
  fromJSON(object: any): QueryIsmRequest;
  toJSON(message: QueryIsmRequest): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): QueryIsmRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): QueryIsmRequest;
};
export declare const QueryIsmResponse: {
  encode(message: QueryIsmResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIsmResponse;
  fromJSON(object: any): QueryIsmResponse;
  toJSON(message: QueryIsmResponse): unknown;
  create<
    I extends {
      ism?:
        | {
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          }
        | undefined;
    } & {
      ism?:
        | ({
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          } & {
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          } & { [K in Exclude<keyof I['ism'], keyof Any>]: never })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'ism'>]: never },
  >(
    base?: I | undefined,
  ): QueryIsmResponse;
  fromPartial<
    I_1 extends {
      ism?:
        | {
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          }
        | undefined;
    } & {
      ism?:
        | ({
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          } & {
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          } & { [K_2 in Exclude<keyof I_1['ism'], keyof Any>]: never })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'ism'>]: never },
  >(
    object: I_1,
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
    I extends {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
    } & {
      [K in Exclude<
        keyof I,
        keyof QueryAnnouncedStorageLocationsRequest
      >]: never;
    },
  >(
    base?: I | undefined,
  ): QueryAnnouncedStorageLocationsRequest;
  fromPartial<
    I_1 extends {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
    } & {
      [K_1 in Exclude<
        keyof I_1,
        keyof QueryAnnouncedStorageLocationsRequest
      >]: never;
    },
  >(
    object: I_1,
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
    I extends {
      storage_locations?: string[] | undefined;
    } & {
      storage_locations?:
        | (string[] &
            string[] & {
              [K in Exclude<
                keyof I['storage_locations'],
                keyof string[]
              >]: never;
            })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'storage_locations'>]: never },
  >(
    base?: I | undefined,
  ): QueryAnnouncedStorageLocationsResponse;
  fromPartial<
    I_1 extends {
      storage_locations?: string[] | undefined;
    } & {
      storage_locations?:
        | (string[] &
            string[] & {
              [K_2 in Exclude<
                keyof I_1['storage_locations'],
                keyof string[]
              >]: never;
            })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'storage_locations'>]: never },
  >(
    object: I_1,
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
    I extends {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
    } & {
      [K in Exclude<
        keyof I,
        keyof QueryLatestAnnouncedStorageLocationRequest
      >]: never;
    },
  >(
    base?: I | undefined,
  ): QueryLatestAnnouncedStorageLocationRequest;
  fromPartial<
    I_1 extends {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
    } & {
      [K_1 in Exclude<
        keyof I_1,
        keyof QueryLatestAnnouncedStorageLocationRequest
      >]: never;
    },
  >(
    object: I_1,
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
    I extends {
      storage_location?: string | undefined;
    } & {
      storage_location?: string | undefined;
    } & { [K in Exclude<keyof I, 'storage_location'>]: never },
  >(
    base?: I | undefined,
  ): QueryLatestAnnouncedStorageLocationResponse;
  fromPartial<
    I_1 extends {
      storage_location?: string | undefined;
    } & {
      storage_location?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'storage_location'>]: never },
  >(
    object: I_1,
  ): QueryLatestAnnouncedStorageLocationResponse;
};
/** Query defines the module Query service. */
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
//# sourceMappingURL=query.d.ts.map
