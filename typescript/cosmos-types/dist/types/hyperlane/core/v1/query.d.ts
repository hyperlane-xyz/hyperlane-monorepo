import _m0 from 'protobufjs/minimal.js';

import {
  PageRequest,
  PageResponse,
} from '../../../cosmos/base/query/v1beta1/pagination.js';

import { Mailbox } from './types.js';

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
/** QueryRecipientIsmRequest ... */
export interface QueryRecipientIsmRequest {
  recipient: string;
}
/** QueryRecipientIsmResponse ... */
export interface QueryRecipientIsmResponse {
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
  ): QueryMailboxesRequest;
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
  create<
    I extends {
      mailboxes?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      mailboxes?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              message_sent?: number | undefined;
              message_received?: number | undefined;
              default_ism?: string | undefined;
              default_hook?: string | undefined;
              required_hook?: string | undefined;
              local_domain?: number | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              message_sent?: number | undefined;
              message_received?: number | undefined;
              default_ism?: string | undefined;
              default_hook?: string | undefined;
              required_hook?: string | undefined;
              local_domain?: number | undefined;
            } & {
              [K in Exclude<
                keyof I['mailboxes'][number],
                keyof Mailbox
              >]: never;
            })[] & {
              [K_1 in Exclude<
                keyof I['mailboxes'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  message_sent?: number | undefined;
                  message_received?: number | undefined;
                  default_ism?: string | undefined;
                  default_hook?: string | undefined;
                  required_hook?: string | undefined;
                  local_domain?: number | undefined;
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
    } & { [K_3 in Exclude<keyof I, keyof QueryMailboxesResponse>]: never },
  >(
    base?: I | undefined,
  ): QueryMailboxesResponse;
  fromPartial<
    I_1 extends {
      mailboxes?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      mailboxes?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              message_sent?: number | undefined;
              message_received?: number | undefined;
              default_ism?: string | undefined;
              default_hook?: string | undefined;
              required_hook?: string | undefined;
              local_domain?: number | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              message_sent?: number | undefined;
              message_received?: number | undefined;
              default_ism?: string | undefined;
              default_hook?: string | undefined;
              required_hook?: string | undefined;
              local_domain?: number | undefined;
            } & {
              [K_4 in Exclude<
                keyof I_1['mailboxes'][number],
                keyof Mailbox
              >]: never;
            })[] & {
              [K_5 in Exclude<
                keyof I_1['mailboxes'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  message_sent?: number | undefined;
                  message_received?: number | undefined;
                  default_ism?: string | undefined;
                  default_hook?: string | undefined;
                  required_hook?: string | undefined;
                  local_domain?: number | undefined;
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
    } & { [K_7 in Exclude<keyof I_1, keyof QueryMailboxesResponse>]: never },
  >(
    object: I_1,
  ): QueryMailboxesResponse;
};
export declare const QueryMailboxRequest: {
  encode(message: QueryMailboxRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryMailboxRequest;
  fromJSON(object: any): QueryMailboxRequest;
  toJSON(message: QueryMailboxRequest): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): QueryMailboxRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): QueryMailboxRequest;
};
export declare const QueryMailboxResponse: {
  encode(message: QueryMailboxResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryMailboxResponse;
  fromJSON(object: any): QueryMailboxResponse;
  toJSON(message: QueryMailboxResponse): unknown;
  create<
    I extends {
      mailbox?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }
        | undefined;
    } & {
      mailbox?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          } & {
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          } & { [K in Exclude<keyof I['mailbox'], keyof Mailbox>]: never })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'mailbox'>]: never },
  >(
    base?: I | undefined,
  ): QueryMailboxResponse;
  fromPartial<
    I_1 extends {
      mailbox?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }
        | undefined;
    } & {
      mailbox?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          } & {
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          } & { [K_2 in Exclude<keyof I_1['mailbox'], keyof Mailbox>]: never })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'mailbox'>]: never },
  >(
    object: I_1,
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
  create<
    I extends {
      id?: string | undefined;
      message_id?: string | undefined;
    } & {
      id?: string | undefined;
      message_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof QueryDeliveredRequest>]: never },
  >(
    base?: I | undefined,
  ): QueryDeliveredRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      message_id?: string | undefined;
    } & {
      id?: string | undefined;
      message_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof QueryDeliveredRequest>]: never },
  >(
    object: I_1,
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
  create<
    I extends {
      delivered?: boolean | undefined;
    } & {
      delivered?: boolean | undefined;
    } & { [K in Exclude<keyof I, 'delivered'>]: never },
  >(
    base?: I | undefined,
  ): QueryDeliveredResponse;
  fromPartial<
    I_1 extends {
      delivered?: boolean | undefined;
    } & {
      delivered?: boolean | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'delivered'>]: never },
  >(
    object: I_1,
  ): QueryDeliveredResponse;
};
export declare const QueryRecipientIsmRequest: {
  encode(message: QueryRecipientIsmRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryRecipientIsmRequest;
  fromJSON(object: any): QueryRecipientIsmRequest;
  toJSON(message: QueryRecipientIsmRequest): unknown;
  create<
    I extends {
      recipient?: string | undefined;
    } & {
      recipient?: string | undefined;
    } & { [K in Exclude<keyof I, 'recipient'>]: never },
  >(
    base?: I | undefined,
  ): QueryRecipientIsmRequest;
  fromPartial<
    I_1 extends {
      recipient?: string | undefined;
    } & {
      recipient?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'recipient'>]: never },
  >(
    object: I_1,
  ): QueryRecipientIsmRequest;
};
export declare const QueryRecipientIsmResponse: {
  encode(message: QueryRecipientIsmResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryRecipientIsmResponse;
  fromJSON(object: any): QueryRecipientIsmResponse;
  toJSON(message: QueryRecipientIsmResponse): unknown;
  create<
    I extends {
      ism_id?: string | undefined;
    } & {
      ism_id?: string | undefined;
    } & { [K in Exclude<keyof I, 'ism_id'>]: never },
  >(
    base?: I | undefined,
  ): QueryRecipientIsmResponse;
  fromPartial<
    I_1 extends {
      ism_id?: string | undefined;
    } & {
      ism_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'ism_id'>]: never },
  >(
    object: I_1,
  ): QueryRecipientIsmResponse;
};
export declare const QueryVerifyDryRunRequest: {
  encode(message: QueryVerifyDryRunRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryVerifyDryRunRequest;
  fromJSON(object: any): QueryVerifyDryRunRequest;
  toJSON(message: QueryVerifyDryRunRequest): unknown;
  create<
    I extends {
      ism_id?: string | undefined;
      message?: string | undefined;
      metadata?: string | undefined;
    } & {
      ism_id?: string | undefined;
      message?: string | undefined;
      metadata?: string | undefined;
    } & { [K in Exclude<keyof I, keyof QueryVerifyDryRunRequest>]: never },
  >(
    base?: I | undefined,
  ): QueryVerifyDryRunRequest;
  fromPartial<
    I_1 extends {
      ism_id?: string | undefined;
      message?: string | undefined;
      metadata?: string | undefined;
    } & {
      ism_id?: string | undefined;
      message?: string | undefined;
      metadata?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof QueryVerifyDryRunRequest>]: never },
  >(
    object: I_1,
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
  create<
    I extends {
      verified?: boolean | undefined;
    } & {
      verified?: boolean | undefined;
    } & { [K in Exclude<keyof I, 'verified'>]: never },
  >(
    base?: I | undefined,
  ): QueryVerifyDryRunResponse;
  fromPartial<
    I_1 extends {
      verified?: boolean | undefined;
    } & {
      verified?: boolean | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'verified'>]: never },
  >(
    object: I_1,
  ): QueryVerifyDryRunResponse;
};
/** Query defines the module Query service. */
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
  RecipientIsm(
    request: QueryRecipientIsmRequest,
  ): Promise<QueryRecipientIsmResponse>;
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
  RecipientIsm(
    request: QueryRecipientIsmRequest,
  ): Promise<QueryRecipientIsmResponse>;
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
//# sourceMappingURL=query.d.ts.map
