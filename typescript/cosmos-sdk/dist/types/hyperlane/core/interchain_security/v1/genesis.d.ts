import _m0 from 'protobufjs/minimal';

import { Any } from '../../../../google/protobuf/any';

export declare const protobufPackage = 'hyperlane.core.interchain_security.v1';
/** GenesisState defines the 01_interchain_security submodule's genesis state. */
export interface GenesisState {
  /** accounts are the accounts present at genesis. */
  isms: Any[];
  validator_storage_locations: ValidatorStorageLocationGenesisWrapper[];
}
/**
 * ValidatorStorageLocationGenesisWrapper stores the information for
 * validator, mailbox and storage-location which validators have announced
 */
export interface ValidatorStorageLocationGenesisWrapper {
  mailbox_id: string;
  validator_address: string;
  index: string;
  storage_location: string;
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
export declare const ValidatorStorageLocationGenesisWrapper: {
  encode(
    message: ValidatorStorageLocationGenesisWrapper,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): ValidatorStorageLocationGenesisWrapper;
  fromJSON(object: any): ValidatorStorageLocationGenesisWrapper;
  toJSON(message: ValidatorStorageLocationGenesisWrapper): unknown;
  create<
    I extends Exact<DeepPartial<ValidatorStorageLocationGenesisWrapper>, I>,
  >(
    base?: I,
  ): ValidatorStorageLocationGenesisWrapper;
  fromPartial<
    I extends Exact<DeepPartial<ValidatorStorageLocationGenesisWrapper>, I>,
  >(
    object: I,
  ): ValidatorStorageLocationGenesisWrapper;
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
