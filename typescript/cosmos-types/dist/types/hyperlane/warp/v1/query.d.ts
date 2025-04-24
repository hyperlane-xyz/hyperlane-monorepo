import _m0 from 'protobufjs/minimal.js';

import {
  PageRequest,
  PageResponse,
} from '../../../cosmos/base/query/v1beta1/pagination.js';
import { Coin } from '../../../cosmos/base/v1beta1/coin.js';

import { HypTokenType, RemoteRouter } from './types.js';

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
/** WrappedHypToken */
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
  ): QueryTokensRequest;
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
  ): QueryTokensRequest;
};
export declare const QueryTokensResponse: {
  encode(message: QueryTokensResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryTokensResponse;
  fromJSON(object: any): QueryTokensResponse;
  toJSON(message: QueryTokensResponse): unknown;
  create<
    I extends {
      tokens?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      tokens?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              token_type?: HypTokenType | undefined;
              origin_mailbox?: string | undefined;
              origin_denom?: string | undefined;
              ism_id?: string | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              token_type?: HypTokenType | undefined;
              origin_mailbox?: string | undefined;
              origin_denom?: string | undefined;
              ism_id?: string | undefined;
            } & {
              [K in Exclude<
                keyof I['tokens'][number],
                keyof WrappedHypToken
              >]: never;
            })[] & {
              [K_1 in Exclude<
                keyof I['tokens'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  token_type?: HypTokenType | undefined;
                  origin_mailbox?: string | undefined;
                  origin_denom?: string | undefined;
                  ism_id?: string | undefined;
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
    } & { [K_3 in Exclude<keyof I, keyof QueryTokensResponse>]: never },
  >(
    base?: I | undefined,
  ): QueryTokensResponse;
  fromPartial<
    I_1 extends {
      tokens?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      tokens?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              token_type?: HypTokenType | undefined;
              origin_mailbox?: string | undefined;
              origin_denom?: string | undefined;
              ism_id?: string | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              token_type?: HypTokenType | undefined;
              origin_mailbox?: string | undefined;
              origin_denom?: string | undefined;
              ism_id?: string | undefined;
            } & {
              [K_4 in Exclude<
                keyof I_1['tokens'][number],
                keyof WrappedHypToken
              >]: never;
            })[] & {
              [K_5 in Exclude<
                keyof I_1['tokens'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  token_type?: HypTokenType | undefined;
                  origin_mailbox?: string | undefined;
                  origin_denom?: string | undefined;
                  ism_id?: string | undefined;
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
    } & { [K_7 in Exclude<keyof I_1, keyof QueryTokensResponse>]: never },
  >(
    object: I_1,
  ): QueryTokensResponse;
};
export declare const QueryTokenRequest: {
  encode(message: QueryTokenRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryTokenRequest;
  fromJSON(object: any): QueryTokenRequest;
  toJSON(message: QueryTokenRequest): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): QueryTokenRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): QueryTokenRequest;
};
export declare const QueryTokenResponse: {
  encode(message: QueryTokenResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryTokenResponse;
  fromJSON(object: any): QueryTokenResponse;
  toJSON(message: QueryTokenResponse): unknown;
  create<
    I extends {
      token?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          }
        | undefined;
    } & {
      token?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          } & {
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          } & {
            [K in Exclude<keyof I['token'], keyof WrappedHypToken>]: never;
          })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'token'>]: never },
  >(
    base?: I | undefined,
  ): QueryTokenResponse;
  fromPartial<
    I_1 extends {
      token?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          }
        | undefined;
    } & {
      token?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          } & {
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            ism_id?: string | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['token'], keyof WrappedHypToken>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'token'>]: never },
  >(
    object: I_1,
  ): QueryTokenResponse;
};
export declare const WrappedHypToken: {
  encode(message: WrappedHypToken, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): WrappedHypToken;
  fromJSON(object: any): WrappedHypToken;
  toJSON(message: WrappedHypToken): unknown;
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
      token_type?: HypTokenType | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
      ism_id?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      token_type?: HypTokenType | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
      ism_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof WrappedHypToken>]: never },
  >(
    base?: I | undefined,
  ): WrappedHypToken;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
      token_type?: HypTokenType | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
      ism_id?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      token_type?: HypTokenType | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
      ism_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof WrappedHypToken>]: never },
  >(
    object: I_1,
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
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): QueryBridgedSupplyRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
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
  create<
    I extends {
      bridged_supply?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }
        | undefined;
    } & {
      bridged_supply?:
        | ({
            denom?: string | undefined;
            amount?: string | undefined;
          } & {
            denom?: string | undefined;
            amount?: string | undefined;
          } & { [K in Exclude<keyof I['bridged_supply'], keyof Coin>]: never })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'bridged_supply'>]: never },
  >(
    base?: I | undefined,
  ): QueryBridgedSupplyResponse;
  fromPartial<
    I_1 extends {
      bridged_supply?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }
        | undefined;
    } & {
      bridged_supply?:
        | ({
            denom?: string | undefined;
            amount?: string | undefined;
          } & {
            denom?: string | undefined;
            amount?: string | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['bridged_supply'], keyof Coin>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'bridged_supply'>]: never },
  >(
    object: I_1,
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
  create<
    I extends {
      id?: string | undefined;
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
      id?: string | undefined;
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
    } & { [K_1 in Exclude<keyof I, keyof QueryRemoteRoutersRequest>]: never },
  >(
    base?: I | undefined,
  ): QueryRemoteRoutersRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
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
      id?: string | undefined;
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
    } & { [K_3 in Exclude<keyof I_1, keyof QueryRemoteRoutersRequest>]: never },
  >(
    object: I_1,
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
  create<
    I extends {
      remote_routers?:
        | {
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      remote_routers?:
        | ({
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          }[] &
            ({
              receiver_domain?: number | undefined;
              receiver_contract?: string | undefined;
              gas?: string | undefined;
            } & {
              receiver_domain?: number | undefined;
              receiver_contract?: string | undefined;
              gas?: string | undefined;
            } & {
              [K in Exclude<
                keyof I['remote_routers'][number],
                keyof RemoteRouter
              >]: never;
            })[] & {
              [K_1 in Exclude<
                keyof I['remote_routers'],
                keyof {
                  receiver_domain?: number | undefined;
                  receiver_contract?: string | undefined;
                  gas?: string | undefined;
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
    } & { [K_3 in Exclude<keyof I, keyof QueryRemoteRoutersResponse>]: never },
  >(
    base?: I | undefined,
  ): QueryRemoteRoutersResponse;
  fromPartial<
    I_1 extends {
      remote_routers?:
        | {
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      remote_routers?:
        | ({
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          }[] &
            ({
              receiver_domain?: number | undefined;
              receiver_contract?: string | undefined;
              gas?: string | undefined;
            } & {
              receiver_domain?: number | undefined;
              receiver_contract?: string | undefined;
              gas?: string | undefined;
            } & {
              [K_4 in Exclude<
                keyof I_1['remote_routers'][number],
                keyof RemoteRouter
              >]: never;
            })[] & {
              [K_5 in Exclude<
                keyof I_1['remote_routers'],
                keyof {
                  receiver_domain?: number | undefined;
                  receiver_contract?: string | undefined;
                  gas?: string | undefined;
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
    } & {
      [K_7 in Exclude<keyof I_1, keyof QueryRemoteRoutersResponse>]: never;
    },
  >(
    object: I_1,
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
  create<
    I extends {
      id?: string | undefined;
      destination_domain?: string | undefined;
    } & {
      id?: string | undefined;
      destination_domain?: string | undefined;
    } & {
      [K in Exclude<keyof I, keyof QueryQuoteRemoteTransferRequest>]: never;
    },
  >(
    base?: I | undefined,
  ): QueryQuoteRemoteTransferRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      destination_domain?: string | undefined;
    } & {
      id?: string | undefined;
      destination_domain?: string | undefined;
    } & {
      [K_1 in Exclude<keyof I_1, keyof QueryQuoteRemoteTransferRequest>]: never;
    },
  >(
    object: I_1,
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
  create<
    I extends {
      gas_payment?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }[]
        | undefined;
    } & {
      gas_payment?:
        | ({
            denom?: string | undefined;
            amount?: string | undefined;
          }[] &
            ({
              denom?: string | undefined;
              amount?: string | undefined;
            } & {
              denom?: string | undefined;
              amount?: string | undefined;
            } & {
              [K in Exclude<keyof I['gas_payment'][number], keyof Coin>]: never;
            })[] & {
              [K_1 in Exclude<
                keyof I['gas_payment'],
                keyof {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_2 in Exclude<keyof I, 'gas_payment'>]: never },
  >(
    base?: I | undefined,
  ): QueryQuoteRemoteTransferResponse;
  fromPartial<
    I_1 extends {
      gas_payment?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }[]
        | undefined;
    } & {
      gas_payment?:
        | ({
            denom?: string | undefined;
            amount?: string | undefined;
          }[] &
            ({
              denom?: string | undefined;
              amount?: string | undefined;
            } & {
              denom?: string | undefined;
              amount?: string | undefined;
            } & {
              [K_3 in Exclude<
                keyof I_1['gas_payment'][number],
                keyof Coin
              >]: never;
            })[] & {
              [K_4 in Exclude<
                keyof I_1['gas_payment'],
                keyof {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_5 in Exclude<keyof I_1, 'gas_payment'>]: never },
  >(
    object: I_1,
  ): QueryQuoteRemoteTransferResponse;
};
/** Query defines the module Query service. */
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
//# sourceMappingURL=query.d.ts.map
