import _m0 from 'protobufjs/minimal';

import { Coin } from '../../../../cosmos/base/v1beta1/coin';

export declare const protobufPackage = 'hyperlane.core.post_dispatch.v1';
/** InterchainGasPaymaster ... */
export interface InterchainGasPaymaster {
  /** id ... */
  id: string;
  /** owner ... */
  owner: string;
  /** denom ... */
  denom: string;
  /** claimable_fees ... */
  claimable_fees: Coin[];
}
/** DestinationGasConfig ... */
export interface DestinationGasConfig {
  /** remote_domain ... */
  remote_domain: number;
  /** gas_oracle ... */
  gas_oracle?: GasOracle | undefined;
  /** gas_overhead ... */
  gas_overhead: string;
}
/** GasOracle ... */
export interface GasOracle {
  /** token_exchange_rate ... */
  token_exchange_rate: string;
  /** gas_price ... */
  gas_price: string;
}
/** MerkleTreeHook ... */
export interface MerkleTreeHook {
  id: string;
  mailbox_id: string;
  /** owner ... */
  owner: string;
  /** tree ... */
  tree?: Tree | undefined;
}
/**
 * Tree represents an incremental merkle tree.
 * Contains current branch and the number of inserted leaves in the tree.
 */
export interface Tree {
  /** branch ... */
  branch: Uint8Array[];
  /** count ... */
  count: number;
}
/** NoopHook ... */
export interface NoopHook {
  /** id ... */
  id: string;
  /** owner ... */
  owner: string;
}
export declare const InterchainGasPaymaster: {
  encode(message: InterchainGasPaymaster, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): InterchainGasPaymaster;
  fromJSON(object: any): InterchainGasPaymaster;
  toJSON(message: InterchainGasPaymaster): unknown;
  create<I extends Exact<DeepPartial<InterchainGasPaymaster>, I>>(
    base?: I,
  ): InterchainGasPaymaster;
  fromPartial<I extends Exact<DeepPartial<InterchainGasPaymaster>, I>>(
    object: I,
  ): InterchainGasPaymaster;
};
export declare const DestinationGasConfig: {
  encode(message: DestinationGasConfig, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): DestinationGasConfig;
  fromJSON(object: any): DestinationGasConfig;
  toJSON(message: DestinationGasConfig): unknown;
  create<I extends Exact<DeepPartial<DestinationGasConfig>, I>>(
    base?: I,
  ): DestinationGasConfig;
  fromPartial<I extends Exact<DeepPartial<DestinationGasConfig>, I>>(
    object: I,
  ): DestinationGasConfig;
};
export declare const GasOracle: {
  encode(message: GasOracle, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): GasOracle;
  fromJSON(object: any): GasOracle;
  toJSON(message: GasOracle): unknown;
  create<I extends Exact<DeepPartial<GasOracle>, I>>(base?: I): GasOracle;
  fromPartial<I extends Exact<DeepPartial<GasOracle>, I>>(object: I): GasOracle;
};
export declare const MerkleTreeHook: {
  encode(message: MerkleTreeHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MerkleTreeHook;
  fromJSON(object: any): MerkleTreeHook;
  toJSON(message: MerkleTreeHook): unknown;
  create<I extends Exact<DeepPartial<MerkleTreeHook>, I>>(
    base?: I,
  ): MerkleTreeHook;
  fromPartial<I extends Exact<DeepPartial<MerkleTreeHook>, I>>(
    object: I,
  ): MerkleTreeHook;
};
export declare const Tree: {
  encode(message: Tree, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): Tree;
  fromJSON(object: any): Tree;
  toJSON(message: Tree): unknown;
  create<I extends Exact<DeepPartial<Tree>, I>>(base?: I): Tree;
  fromPartial<I extends Exact<DeepPartial<Tree>, I>>(object: I): Tree;
};
export declare const NoopHook: {
  encode(message: NoopHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): NoopHook;
  fromJSON(object: any): NoopHook;
  toJSON(message: NoopHook): unknown;
  create<I extends Exact<DeepPartial<NoopHook>, I>>(base?: I): NoopHook;
  fromPartial<I extends Exact<DeepPartial<NoopHook>, I>>(object: I): NoopHook;
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
