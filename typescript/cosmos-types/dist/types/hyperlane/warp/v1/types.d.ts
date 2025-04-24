import _m0 from 'protobufjs/minimal.js';

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
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): Params;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): Params;
};
export declare const HypToken: {
  encode(message: HypToken, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): HypToken;
  fromJSON(object: any): HypToken;
  toJSON(message: HypToken): unknown;
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
      token_type?: HypTokenType | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
      collateral_balance?: string | undefined;
      ism_id?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      token_type?: HypTokenType | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
      collateral_balance?: string | undefined;
      ism_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof HypToken>]: never },
  >(
    base?: I | undefined,
  ): HypToken;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
      token_type?: HypTokenType | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
      collateral_balance?: string | undefined;
      ism_id?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      token_type?: HypTokenType | undefined;
      origin_mailbox?: string | undefined;
      origin_denom?: string | undefined;
      collateral_balance?: string | undefined;
      ism_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof HypToken>]: never },
  >(
    object: I_1,
  ): HypToken;
};
export declare const RemoteRouter: {
  encode(message: RemoteRouter, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): RemoteRouter;
  fromJSON(object: any): RemoteRouter;
  toJSON(message: RemoteRouter): unknown;
  create<
    I extends {
      receiver_domain?: number | undefined;
      receiver_contract?: string | undefined;
      gas?: string | undefined;
    } & {
      receiver_domain?: number | undefined;
      receiver_contract?: string | undefined;
      gas?: string | undefined;
    } & { [K in Exclude<keyof I, keyof RemoteRouter>]: never },
  >(
    base?: I | undefined,
  ): RemoteRouter;
  fromPartial<
    I_1 extends {
      receiver_domain?: number | undefined;
      receiver_contract?: string | undefined;
      gas?: string | undefined;
    } & {
      receiver_domain?: number | undefined;
      receiver_contract?: string | undefined;
      gas?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof RemoteRouter>]: never },
  >(
    object: I_1,
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
//# sourceMappingURL=types.d.ts.map
