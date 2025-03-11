import _m0 from 'protobufjs/minimal';

export declare const protobufPackage = 'hyperlane.warp.v1';
/** HypTokenType ... */
export declare enum HypTokenType {
  /** HYP_TOKEN_TYPE_UNSPECIFIED - HYP_TOKEN_TYPE_UNSPECIFIED ... */
  HYP_TOKEN_TYPE_UNSPECIFIED = 'HYP_TOKEN_TYPE_UNSPECIFIED',
  /** HYP_TOKEN_TYPE_COLLATERAL - HYP_TOKEN_TYPE_COLLATERAL ... */
  HYP_TOKEN_TYPE_COLLATERAL = 'HYP_TOKEN_TYPE_COLLATERAL',
  /** HYP_TOKEN_TYPE_SYNTHETIC - HYP_TOKEN_TYPE_SYNTHETIC ... */
  HYP_TOKEN_TYPE_SYNTHETIC = 'HYP_TOKEN_TYPE_SYNTHETIC',
  UNRECOGNIZED = 'UNRECOGNIZED',
}
export declare function hypTokenTypeFromJSON(object: any): HypTokenType;
export declare function hypTokenTypeToJSON(object: HypTokenType): string;
export declare function hypTokenTypeToNumber(object: HypTokenType): number;
/** Params */
export interface Params {}
/** GenesisState is the state that must be provided at genesis. */
export interface GenesisState {
  params?: Params | undefined;
  tokens: HypToken[];
}
/** HypToken ... */
export interface HypToken {
  id: string;
  owner: string;
  token_type: HypTokenType;
  origin_mailbox: string;
  origin_denom: string;
  collateral_balance: string;
  ism_id: string;
}
/** RemoteRouter ... */
export interface RemoteRouter {
  receiver_domain: number;
  receiver_contract: string;
  gas: string;
}
export declare const Params: {
  encode(_: Params, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): Params;
  fromJSON(_: any): Params;
  toJSON(_: Params): unknown;
  create<I extends Exact<DeepPartial<Params>, I>>(base?: I): Params;
  fromPartial<I extends Exact<DeepPartial<Params>, I>>(_: I): Params;
};
export declare const GenesisState: {
  encode(message: GenesisState, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): GenesisState;
  fromJSON(object: any): GenesisState;
  toJSON(message: GenesisState): unknown;
  create<I extends Exact<DeepPartial<GenesisState>, I>>(base?: I): GenesisState;
  fromPartial<I extends Exact<DeepPartial<GenesisState>, I>>(
    object: I,
  ): GenesisState;
};
export declare const HypToken: {
  encode(message: HypToken, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): HypToken;
  fromJSON(object: any): HypToken;
  toJSON(message: HypToken): unknown;
  create<I extends Exact<DeepPartial<HypToken>, I>>(base?: I): HypToken;
  fromPartial<I extends Exact<DeepPartial<HypToken>, I>>(object: I): HypToken;
};
export declare const RemoteRouter: {
  encode(message: RemoteRouter, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): RemoteRouter;
  fromJSON(object: any): RemoteRouter;
  toJSON(message: RemoteRouter): unknown;
  create<I extends Exact<DeepPartial<RemoteRouter>, I>>(base?: I): RemoteRouter;
  fromPartial<I extends Exact<DeepPartial<RemoteRouter>, I>>(
    object: I,
  ): RemoteRouter;
};
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
