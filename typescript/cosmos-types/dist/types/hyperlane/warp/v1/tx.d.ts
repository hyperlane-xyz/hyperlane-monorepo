import _m0 from 'protobufjs/minimal.js';

import { Coin } from '../../../cosmos/base/v1beta1/coin.js';

import { RemoteRouter } from './types.js';

export declare const protobufPackage = 'hyperlane.warp.v1';
/** MsgCreateCollateralToken ... */
export interface MsgCreateCollateralToken {
  /** owner is the message sender. */
  owner: string;
  origin_mailbox: string;
  origin_denom: string;
}
/** MsgCreateCollateralTokenResponse ... */
export interface MsgCreateCollateralTokenResponse {
  id: string;
}
/** MsgCreateSyntheticToken ... */
export interface MsgCreateSyntheticToken {
  /** owner is the message sender. */
  owner: string;
  origin_mailbox: string;
}
/** MsgCreateSyntheticTokenResponse ... */
export interface MsgCreateSyntheticTokenResponse {
  id: string;
}
/** MsgSetToken ... */
export interface MsgSetToken {
  /** owner is the message sender. */
  owner: string;
  token_id: string;
  new_owner: string;
  ism_id: string;
}
/** MsgSetTokenResponse ... */
export interface MsgSetTokenResponse {}
/** MsgEnrollRemoteRouter ... */
export interface MsgEnrollRemoteRouter {
  /** owner is the message sender. */
  owner: string;
  token_id: string;
  remote_router?: RemoteRouter | undefined;
}
/** MsgEnrollRemoteRouterResponse ... */
export interface MsgEnrollRemoteRouterResponse {}
/** MsgUnrollRemoteRouter ... */
export interface MsgUnrollRemoteRouter {
  /** owner is the message sender. */
  owner: string;
  token_id: string;
  receiver_domain: number;
}
/** MsgUnrollRemoteRouterResponse ... */
export interface MsgUnrollRemoteRouterResponse {}
/** MsgRemoteTransfer ... */
export interface MsgRemoteTransfer {
  sender: string;
  token_id: string;
  destination_domain: number;
  recipient: string;
  amount: string;
  /** Post Dispatch */
  custom_hook_id: string;
  gas_limit: string;
  max_fee?: Coin | undefined;
  custom_hook_metadata: string;
}
/** MsgRemoteTransferResponse ... */
export interface MsgRemoteTransferResponse {
  message_id: string;
}
export declare const MsgCreateCollateralToken: {
  encode(message: MsgCreateCollateralToken, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateCollateralToken;
  fromJSON(object: any): MsgCreateCollateralToken;
  toJSON(message: MsgCreateCollateralToken): unknown;
  create<
    I extends {
      owner?: string | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
    } & {
      owner?: string | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgCreateCollateralToken>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateCollateralToken;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
    } & {
      owner?: string | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgCreateCollateralToken>]: never },
  >(
    object: I_1,
  ): MsgCreateCollateralToken;
};
export declare const MsgCreateCollateralTokenResponse: {
  encode(
    message: MsgCreateCollateralTokenResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateCollateralTokenResponse;
  fromJSON(object: any): MsgCreateCollateralTokenResponse;
  toJSON(message: MsgCreateCollateralTokenResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateCollateralTokenResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateCollateralTokenResponse;
};
export declare const MsgCreateSyntheticToken: {
  encode(message: MsgCreateSyntheticToken, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateSyntheticToken;
  fromJSON(object: any): MsgCreateSyntheticToken;
  toJSON(message: MsgCreateSyntheticToken): unknown;
  create<
    I extends {
      owner?: string | undefined;
      origin_mailbox?: string | undefined;
    } & {
      owner?: string | undefined;
      origin_mailbox?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgCreateSyntheticToken>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateSyntheticToken;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      origin_mailbox?: string | undefined;
    } & {
      owner?: string | undefined;
      origin_mailbox?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgCreateSyntheticToken>]: never },
  >(
    object: I_1,
  ): MsgCreateSyntheticToken;
};
export declare const MsgCreateSyntheticTokenResponse: {
  encode(
    message: MsgCreateSyntheticTokenResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateSyntheticTokenResponse;
  fromJSON(object: any): MsgCreateSyntheticTokenResponse;
  toJSON(message: MsgCreateSyntheticTokenResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateSyntheticTokenResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateSyntheticTokenResponse;
};
export declare const MsgSetToken: {
  encode(message: MsgSetToken, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgSetToken;
  fromJSON(object: any): MsgSetToken;
  toJSON(message: MsgSetToken): unknown;
  create<
    I extends {
      owner?: string | undefined;
      token_id?: string | undefined;
      new_owner?: string | undefined;
      ism_id?: string | undefined;
    } & {
      owner?: string | undefined;
      token_id?: string | undefined;
      new_owner?: string | undefined;
      ism_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgSetToken>]: never },
  >(
    base?: I | undefined,
  ): MsgSetToken;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      token_id?: string | undefined;
      new_owner?: string | undefined;
      ism_id?: string | undefined;
    } & {
      owner?: string | undefined;
      token_id?: string | undefined;
      new_owner?: string | undefined;
      ism_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgSetToken>]: never },
  >(
    object: I_1,
  ): MsgSetToken;
};
export declare const MsgSetTokenResponse: {
  encode(_: MsgSetTokenResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgSetTokenResponse;
  fromJSON(_: any): MsgSetTokenResponse;
  toJSON(_: MsgSetTokenResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgSetTokenResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgSetTokenResponse;
};
export declare const MsgEnrollRemoteRouter: {
  encode(message: MsgEnrollRemoteRouter, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgEnrollRemoteRouter;
  fromJSON(object: any): MsgEnrollRemoteRouter;
  toJSON(message: MsgEnrollRemoteRouter): unknown;
  create<
    I extends {
      owner?: string | undefined;
      token_id?: string | undefined;
      remote_router?:
        | {
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          }
        | undefined;
    } & {
      owner?: string | undefined;
      token_id?: string | undefined;
      remote_router?:
        | ({
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          } & {
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          } & {
            [K in Exclude<keyof I['remote_router'], keyof RemoteRouter>]: never;
          })
        | undefined;
    } & { [K_1 in Exclude<keyof I, keyof MsgEnrollRemoteRouter>]: never },
  >(
    base?: I | undefined,
  ): MsgEnrollRemoteRouter;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      token_id?: string | undefined;
      remote_router?:
        | {
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          }
        | undefined;
    } & {
      owner?: string | undefined;
      token_id?: string | undefined;
      remote_router?:
        | ({
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          } & {
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          } & {
            [K_2 in Exclude<
              keyof I_1['remote_router'],
              keyof RemoteRouter
            >]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, keyof MsgEnrollRemoteRouter>]: never },
  >(
    object: I_1,
  ): MsgEnrollRemoteRouter;
};
export declare const MsgEnrollRemoteRouterResponse: {
  encode(_: MsgEnrollRemoteRouterResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgEnrollRemoteRouterResponse;
  fromJSON(_: any): MsgEnrollRemoteRouterResponse;
  toJSON(_: MsgEnrollRemoteRouterResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgEnrollRemoteRouterResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgEnrollRemoteRouterResponse;
};
export declare const MsgUnrollRemoteRouter: {
  encode(message: MsgUnrollRemoteRouter, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgUnrollRemoteRouter;
  fromJSON(object: any): MsgUnrollRemoteRouter;
  toJSON(message: MsgUnrollRemoteRouter): unknown;
  create<
    I extends {
      owner?: string | undefined;
      token_id?: string | undefined;
      receiver_domain?: number | undefined;
    } & {
      owner?: string | undefined;
      token_id?: string | undefined;
      receiver_domain?: number | undefined;
    } & { [K in Exclude<keyof I, keyof MsgUnrollRemoteRouter>]: never },
  >(
    base?: I | undefined,
  ): MsgUnrollRemoteRouter;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      token_id?: string | undefined;
      receiver_domain?: number | undefined;
    } & {
      owner?: string | undefined;
      token_id?: string | undefined;
      receiver_domain?: number | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgUnrollRemoteRouter>]: never },
  >(
    object: I_1,
  ): MsgUnrollRemoteRouter;
};
export declare const MsgUnrollRemoteRouterResponse: {
  encode(_: MsgUnrollRemoteRouterResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgUnrollRemoteRouterResponse;
  fromJSON(_: any): MsgUnrollRemoteRouterResponse;
  toJSON(_: MsgUnrollRemoteRouterResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgUnrollRemoteRouterResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgUnrollRemoteRouterResponse;
};
export declare const MsgRemoteTransfer: {
  encode(message: MsgRemoteTransfer, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgRemoteTransfer;
  fromJSON(object: any): MsgRemoteTransfer;
  toJSON(message: MsgRemoteTransfer): unknown;
  create<
    I extends {
      sender?: string | undefined;
      token_id?: string | undefined;
      destination_domain?: number | undefined;
      recipient?: string | undefined;
      amount?: string | undefined;
      custom_hook_id?: string | undefined;
      gas_limit?: string | undefined;
      max_fee?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }
        | undefined;
      custom_hook_metadata?: string | undefined;
    } & {
      sender?: string | undefined;
      token_id?: string | undefined;
      destination_domain?: number | undefined;
      recipient?: string | undefined;
      amount?: string | undefined;
      custom_hook_id?: string | undefined;
      gas_limit?: string | undefined;
      max_fee?:
        | ({
            denom?: string | undefined;
            amount?: string | undefined;
          } & {
            denom?: string | undefined;
            amount?: string | undefined;
          } & { [K in Exclude<keyof I['max_fee'], keyof Coin>]: never })
        | undefined;
      custom_hook_metadata?: string | undefined;
    } & { [K_1 in Exclude<keyof I, keyof MsgRemoteTransfer>]: never },
  >(
    base?: I | undefined,
  ): MsgRemoteTransfer;
  fromPartial<
    I_1 extends {
      sender?: string | undefined;
      token_id?: string | undefined;
      destination_domain?: number | undefined;
      recipient?: string | undefined;
      amount?: string | undefined;
      custom_hook_id?: string | undefined;
      gas_limit?: string | undefined;
      max_fee?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }
        | undefined;
      custom_hook_metadata?: string | undefined;
    } & {
      sender?: string | undefined;
      token_id?: string | undefined;
      destination_domain?: number | undefined;
      recipient?: string | undefined;
      amount?: string | undefined;
      custom_hook_id?: string | undefined;
      gas_limit?: string | undefined;
      max_fee?:
        | ({
            denom?: string | undefined;
            amount?: string | undefined;
          } & {
            denom?: string | undefined;
            amount?: string | undefined;
          } & { [K_2 in Exclude<keyof I_1['max_fee'], keyof Coin>]: never })
        | undefined;
      custom_hook_metadata?: string | undefined;
    } & { [K_3 in Exclude<keyof I_1, keyof MsgRemoteTransfer>]: never },
  >(
    object: I_1,
  ): MsgRemoteTransfer;
};
export declare const MsgRemoteTransferResponse: {
  encode(message: MsgRemoteTransferResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgRemoteTransferResponse;
  fromJSON(object: any): MsgRemoteTransferResponse;
  toJSON(message: MsgRemoteTransferResponse): unknown;
  create<
    I extends {
      message_id?: string | undefined;
    } & {
      message_id?: string | undefined;
    } & { [K in Exclude<keyof I, 'message_id'>]: never },
  >(
    base?: I | undefined,
  ): MsgRemoteTransferResponse;
  fromPartial<
    I_1 extends {
      message_id?: string | undefined;
    } & {
      message_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'message_id'>]: never },
  >(
    object: I_1,
  ): MsgRemoteTransferResponse;
};
/** Msg defines the module Msg service. */
export interface Msg {
  /** CreateCollateralToken ... */
  CreateCollateralToken(
    request: MsgCreateCollateralToken,
  ): Promise<MsgCreateCollateralTokenResponse>;
  /** CreateSyntheticToken ... */
  CreateSyntheticToken(
    request: MsgCreateSyntheticToken,
  ): Promise<MsgCreateSyntheticTokenResponse>;
  /** SetToken ... */
  SetToken(request: MsgSetToken): Promise<MsgSetTokenResponse>;
  /** EnrollRemoteRouter ... */
  EnrollRemoteRouter(
    request: MsgEnrollRemoteRouter,
  ): Promise<MsgEnrollRemoteRouterResponse>;
  /** UnrollRemoteRouter ... */
  UnrollRemoteRouter(
    request: MsgUnrollRemoteRouter,
  ): Promise<MsgUnrollRemoteRouterResponse>;
  /** RemoteTransfer ... */
  RemoteTransfer(
    request: MsgRemoteTransfer,
  ): Promise<MsgRemoteTransferResponse>;
}
export declare const MsgServiceName = 'hyperlane.warp.v1.Msg';
export declare class MsgClientImpl implements Msg {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  CreateCollateralToken(
    request: MsgCreateCollateralToken,
  ): Promise<MsgCreateCollateralTokenResponse>;
  CreateSyntheticToken(
    request: MsgCreateSyntheticToken,
  ): Promise<MsgCreateSyntheticTokenResponse>;
  SetToken(request: MsgSetToken): Promise<MsgSetTokenResponse>;
  EnrollRemoteRouter(
    request: MsgEnrollRemoteRouter,
  ): Promise<MsgEnrollRemoteRouterResponse>;
  UnrollRemoteRouter(
    request: MsgUnrollRemoteRouter,
  ): Promise<MsgUnrollRemoteRouterResponse>;
  RemoteTransfer(
    request: MsgRemoteTransfer,
  ): Promise<MsgRemoteTransferResponse>;
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
//# sourceMappingURL=tx.d.ts.map
