import _m0 from 'protobufjs/minimal';

import {
  GasOracle,
  InterchainGasPaymaster,
  MerkleTreeHook,
  NoopHook,
} from './types';

export declare const protobufPackage = 'hyperlane.core.post_dispatch.v1';
/** GenesisState defines the post dispatch submodule's genesis state. */
export interface GenesisState {
  igps: InterchainGasPaymaster[];
  igp_gas_configs: DestinationGasConfigGenesisWrapper[];
  merkle_tree_hooks: MerkleTreeHook[];
  noop_hooks: NoopHook[];
}
/** DestinationGasConfigGenesisWrapper ... */
export interface DestinationGasConfigGenesisWrapper {
  /** remote_domain ... */
  remote_domain: number;
  /** gas_oracle ... */
  gas_oracle?: GasOracle | undefined;
  /** gas_overhead ... */
  gas_overhead: string;
  /** igp_id is required for the Genesis handling. */
  igp_id: string;
}
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
export declare const DestinationGasConfigGenesisWrapper: {
  encode(
    message: DestinationGasConfigGenesisWrapper,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): DestinationGasConfigGenesisWrapper;
  fromJSON(object: any): DestinationGasConfigGenesisWrapper;
  toJSON(message: DestinationGasConfigGenesisWrapper): unknown;
  create<I extends Exact<DeepPartial<DestinationGasConfigGenesisWrapper>, I>>(
    base?: I,
  ): DestinationGasConfigGenesisWrapper;
  fromPartial<
    I extends Exact<DeepPartial<DestinationGasConfigGenesisWrapper>, I>,
  >(
    object: I,
  ): DestinationGasConfigGenesisWrapper;
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
