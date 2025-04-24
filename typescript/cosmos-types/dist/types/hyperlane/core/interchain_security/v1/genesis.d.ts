import _m0 from 'protobufjs/minimal.js';

import { Any } from '../../../../google/protobuf/any.js';

export declare const protobufPackage = 'hyperlane.core.interchain_security.v1';
/** GenesisState defines the 01_interchain_security submodule's genesis state. */
export interface GenesisState {
  /** accounts are the accounts present at genesis. */
  isms: Any[];
  validator_storage_locations: GenesisValidatorStorageLocationWrapper[];
}
/**
 * GenesisValidatorStorageLocationWrapper stores the information for
 * validator, mailbox and storage-location which validators have announced
 */
export interface GenesisValidatorStorageLocationWrapper {
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
  create<
    I extends {
      isms?:
        | {
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          }[]
        | undefined;
      validator_storage_locations?:
        | {
            mailbox_id?: string | undefined;
            validator_address?: string | undefined;
            index?: string | undefined;
            storage_location?: string | undefined;
          }[]
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
      validator_storage_locations?:
        | ({
            mailbox_id?: string | undefined;
            validator_address?: string | undefined;
            index?: string | undefined;
            storage_location?: string | undefined;
          }[] &
            ({
              mailbox_id?: string | undefined;
              validator_address?: string | undefined;
              index?: string | undefined;
              storage_location?: string | undefined;
            } & {
              mailbox_id?: string | undefined;
              validator_address?: string | undefined;
              index?: string | undefined;
              storage_location?: string | undefined;
            } & {
              [K_2 in Exclude<
                keyof I['validator_storage_locations'][number],
                keyof GenesisValidatorStorageLocationWrapper
              >]: never;
            })[] & {
              [K_3 in Exclude<
                keyof I['validator_storage_locations'],
                keyof {
                  mailbox_id?: string | undefined;
                  validator_address?: string | undefined;
                  index?: string | undefined;
                  storage_location?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_4 in Exclude<keyof I, keyof GenesisState>]: never },
  >(
    base?: I | undefined,
  ): GenesisState;
  fromPartial<
    I_1 extends {
      isms?:
        | {
            type_url?: string | undefined;
            value?: Uint8Array | undefined;
          }[]
        | undefined;
      validator_storage_locations?:
        | {
            mailbox_id?: string | undefined;
            validator_address?: string | undefined;
            index?: string | undefined;
            storage_location?: string | undefined;
          }[]
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
              [K_5 in Exclude<keyof I_1['isms'][number], keyof Any>]: never;
            })[] & {
              [K_6 in Exclude<
                keyof I_1['isms'],
                keyof {
                  type_url?: string | undefined;
                  value?: Uint8Array | undefined;
                }[]
              >]: never;
            })
        | undefined;
      validator_storage_locations?:
        | ({
            mailbox_id?: string | undefined;
            validator_address?: string | undefined;
            index?: string | undefined;
            storage_location?: string | undefined;
          }[] &
            ({
              mailbox_id?: string | undefined;
              validator_address?: string | undefined;
              index?: string | undefined;
              storage_location?: string | undefined;
            } & {
              mailbox_id?: string | undefined;
              validator_address?: string | undefined;
              index?: string | undefined;
              storage_location?: string | undefined;
            } & {
              [K_7 in Exclude<
                keyof I_1['validator_storage_locations'][number],
                keyof GenesisValidatorStorageLocationWrapper
              >]: never;
            })[] & {
              [K_8 in Exclude<
                keyof I_1['validator_storage_locations'],
                keyof {
                  mailbox_id?: string | undefined;
                  validator_address?: string | undefined;
                  index?: string | undefined;
                  storage_location?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_9 in Exclude<keyof I_1, keyof GenesisState>]: never },
  >(
    object: I_1,
  ): GenesisState;
};
export declare const GenesisValidatorStorageLocationWrapper: {
  encode(
    message: GenesisValidatorStorageLocationWrapper,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): GenesisValidatorStorageLocationWrapper;
  fromJSON(object: any): GenesisValidatorStorageLocationWrapper;
  toJSON(message: GenesisValidatorStorageLocationWrapper): unknown;
  create<
    I extends {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
      index?: string | undefined;
      storage_location?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
      index?: string | undefined;
      storage_location?: string | undefined;
    } & {
      [K in Exclude<
        keyof I,
        keyof GenesisValidatorStorageLocationWrapper
      >]: never;
    },
  >(
    base?: I | undefined,
  ): GenesisValidatorStorageLocationWrapper;
  fromPartial<
    I_1 extends {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
      index?: string | undefined;
      storage_location?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      validator_address?: string | undefined;
      index?: string | undefined;
      storage_location?: string | undefined;
    } & {
      [K_1 in Exclude<
        keyof I_1,
        keyof GenesisValidatorStorageLocationWrapper
      >]: never;
    },
  >(
    object: I_1,
  ): GenesisValidatorStorageLocationWrapper;
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
//# sourceMappingURL=genesis.d.ts.map
