import _m0 from 'protobufjs/minimal';

import { Coin } from '../../../cosmos/base/v1beta1/coin';

import { RemoteRouter } from './types';

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
  create<I extends Exact<DeepPartial<MsgCreateCollateralToken>, I>>(
    base?: I,
  ): MsgCreateCollateralToken;
  fromPartial<I extends Exact<DeepPartial<MsgCreateCollateralToken>, I>>(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgCreateCollateralTokenResponse>, I>>(
    base?: I,
  ): MsgCreateCollateralTokenResponse;
  fromPartial<
    I extends Exact<DeepPartial<MsgCreateCollateralTokenResponse>, I>,
  >(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgCreateSyntheticToken>, I>>(
    base?: I,
  ): MsgCreateSyntheticToken;
  fromPartial<I extends Exact<DeepPartial<MsgCreateSyntheticToken>, I>>(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgCreateSyntheticTokenResponse>, I>>(
    base?: I,
  ): MsgCreateSyntheticTokenResponse;
  fromPartial<I extends Exact<DeepPartial<MsgCreateSyntheticTokenResponse>, I>>(
    object: I,
  ): MsgCreateSyntheticTokenResponse;
};
export declare const MsgSetToken: {
  encode(message: MsgSetToken, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgSetToken;
  fromJSON(object: any): MsgSetToken;
  toJSON(message: MsgSetToken): unknown;
  create<I extends Exact<DeepPartial<MsgSetToken>, I>>(base?: I): MsgSetToken;
  fromPartial<I extends Exact<DeepPartial<MsgSetToken>, I>>(
    object: I,
  ): MsgSetToken;
};
export declare const MsgSetTokenResponse: {
  encode(_: MsgSetTokenResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgSetTokenResponse;
  fromJSON(_: any): MsgSetTokenResponse;
  toJSON(_: MsgSetTokenResponse): unknown;
  create<I extends Exact<DeepPartial<MsgSetTokenResponse>, I>>(
    base?: I,
  ): MsgSetTokenResponse;
  fromPartial<I extends Exact<DeepPartial<MsgSetTokenResponse>, I>>(
    _: I,
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
  create<I extends Exact<DeepPartial<MsgEnrollRemoteRouter>, I>>(
    base?: I,
  ): MsgEnrollRemoteRouter;
  fromPartial<I extends Exact<DeepPartial<MsgEnrollRemoteRouter>, I>>(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgEnrollRemoteRouterResponse>, I>>(
    base?: I,
  ): MsgEnrollRemoteRouterResponse;
  fromPartial<I extends Exact<DeepPartial<MsgEnrollRemoteRouterResponse>, I>>(
    _: I,
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
  create<I extends Exact<DeepPartial<MsgUnrollRemoteRouter>, I>>(
    base?: I,
  ): MsgUnrollRemoteRouter;
  fromPartial<I extends Exact<DeepPartial<MsgUnrollRemoteRouter>, I>>(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgUnrollRemoteRouterResponse>, I>>(
    base?: I,
  ): MsgUnrollRemoteRouterResponse;
  fromPartial<I extends Exact<DeepPartial<MsgUnrollRemoteRouterResponse>, I>>(
    _: I,
  ): MsgUnrollRemoteRouterResponse;
};
export declare const MsgRemoteTransfer: {
  encode(message: MsgRemoteTransfer, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgRemoteTransfer;
  fromJSON(object: any): MsgRemoteTransfer;
  toJSON(message: MsgRemoteTransfer): unknown;
  create<I extends Exact<DeepPartial<MsgRemoteTransfer>, I>>(
    base?: I,
  ): MsgRemoteTransfer;
  fromPartial<I extends Exact<DeepPartial<MsgRemoteTransfer>, I>>(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgRemoteTransferResponse>, I>>(
    base?: I,
  ): MsgRemoteTransferResponse;
  fromPartial<I extends Exact<DeepPartial<MsgRemoteTransferResponse>, I>>(
    object: I,
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
