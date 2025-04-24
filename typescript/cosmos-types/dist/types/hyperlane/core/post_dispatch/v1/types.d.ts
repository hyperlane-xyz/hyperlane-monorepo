import _m0 from 'protobufjs/minimal.js';

import { Coin } from '../../../../cosmos/base/v1beta1/coin.js';

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
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
      denom?: string | undefined;
      claimable_fees?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }[]
        | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      denom?: string | undefined;
      claimable_fees?:
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
              [K in Exclude<
                keyof I['claimable_fees'][number],
                keyof Coin
              >]: never;
            })[] & {
              [K_1 in Exclude<
                keyof I['claimable_fees'],
                keyof {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_2 in Exclude<keyof I, keyof InterchainGasPaymaster>]: never },
  >(
    base?: I | undefined,
  ): InterchainGasPaymaster;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
      denom?: string | undefined;
      claimable_fees?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }[]
        | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      denom?: string | undefined;
      claimable_fees?:
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
                keyof I_1['claimable_fees'][number],
                keyof Coin
              >]: never;
            })[] & {
              [K_4 in Exclude<
                keyof I_1['claimable_fees'],
                keyof {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_5 in Exclude<keyof I_1, keyof InterchainGasPaymaster>]: never },
  >(
    object: I_1,
  ): InterchainGasPaymaster;
};
export declare const DestinationGasConfig: {
  encode(message: DestinationGasConfig, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): DestinationGasConfig;
  fromJSON(object: any): DestinationGasConfig;
  toJSON(message: DestinationGasConfig): unknown;
  create<
    I extends {
      remote_domain?: number | undefined;
      gas_oracle?:
        | {
            token_exchange_rate?: string | undefined;
            gas_price?: string | undefined;
          }
        | undefined;
      gas_overhead?: string | undefined;
    } & {
      remote_domain?: number | undefined;
      gas_oracle?:
        | ({
            token_exchange_rate?: string | undefined;
            gas_price?: string | undefined;
          } & {
            token_exchange_rate?: string | undefined;
            gas_price?: string | undefined;
          } & { [K in Exclude<keyof I['gas_oracle'], keyof GasOracle>]: never })
        | undefined;
      gas_overhead?: string | undefined;
    } & { [K_1 in Exclude<keyof I, keyof DestinationGasConfig>]: never },
  >(
    base?: I | undefined,
  ): DestinationGasConfig;
  fromPartial<
    I_1 extends {
      remote_domain?: number | undefined;
      gas_oracle?:
        | {
            token_exchange_rate?: string | undefined;
            gas_price?: string | undefined;
          }
        | undefined;
      gas_overhead?: string | undefined;
    } & {
      remote_domain?: number | undefined;
      gas_oracle?:
        | ({
            token_exchange_rate?: string | undefined;
            gas_price?: string | undefined;
          } & {
            token_exchange_rate?: string | undefined;
            gas_price?: string | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['gas_oracle'], keyof GasOracle>]: never;
          })
        | undefined;
      gas_overhead?: string | undefined;
    } & { [K_3 in Exclude<keyof I_1, keyof DestinationGasConfig>]: never },
  >(
    object: I_1,
  ): DestinationGasConfig;
};
export declare const GasOracle: {
  encode(message: GasOracle, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): GasOracle;
  fromJSON(object: any): GasOracle;
  toJSON(message: GasOracle): unknown;
  create<
    I extends {
      token_exchange_rate?: string | undefined;
      gas_price?: string | undefined;
    } & {
      token_exchange_rate?: string | undefined;
      gas_price?: string | undefined;
    } & { [K in Exclude<keyof I, keyof GasOracle>]: never },
  >(
    base?: I | undefined,
  ): GasOracle;
  fromPartial<
    I_1 extends {
      token_exchange_rate?: string | undefined;
      gas_price?: string | undefined;
    } & {
      token_exchange_rate?: string | undefined;
      gas_price?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof GasOracle>]: never },
  >(
    object: I_1,
  ): GasOracle;
};
export declare const MerkleTreeHook: {
  encode(message: MerkleTreeHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MerkleTreeHook;
  fromJSON(object: any): MerkleTreeHook;
  toJSON(message: MerkleTreeHook): unknown;
  create<
    I extends {
      id?: string | undefined;
      mailbox_id?: string | undefined;
      owner?: string | undefined;
      tree?:
        | {
            branch?: Uint8Array[] | undefined;
            count?: number | undefined;
          }
        | undefined;
    } & {
      id?: string | undefined;
      mailbox_id?: string | undefined;
      owner?: string | undefined;
      tree?:
        | ({
            branch?: Uint8Array[] | undefined;
            count?: number | undefined;
          } & {
            branch?:
              | (Uint8Array[] &
                  Uint8Array[] & {
                    [K in Exclude<
                      keyof I['tree']['branch'],
                      keyof Uint8Array[]
                    >]: never;
                  })
              | undefined;
            count?: number | undefined;
          } & { [K_1 in Exclude<keyof I['tree'], keyof Tree>]: never })
        | undefined;
    } & { [K_2 in Exclude<keyof I, keyof MerkleTreeHook>]: never },
  >(
    base?: I | undefined,
  ): MerkleTreeHook;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      mailbox_id?: string | undefined;
      owner?: string | undefined;
      tree?:
        | {
            branch?: Uint8Array[] | undefined;
            count?: number | undefined;
          }
        | undefined;
    } & {
      id?: string | undefined;
      mailbox_id?: string | undefined;
      owner?: string | undefined;
      tree?:
        | ({
            branch?: Uint8Array[] | undefined;
            count?: number | undefined;
          } & {
            branch?:
              | (Uint8Array[] &
                  Uint8Array[] & {
                    [K_3 in Exclude<
                      keyof I_1['tree']['branch'],
                      keyof Uint8Array[]
                    >]: never;
                  })
              | undefined;
            count?: number | undefined;
          } & { [K_4 in Exclude<keyof I_1['tree'], keyof Tree>]: never })
        | undefined;
    } & { [K_5 in Exclude<keyof I_1, keyof MerkleTreeHook>]: never },
  >(
    object: I_1,
  ): MerkleTreeHook;
};
export declare const Tree: {
  encode(message: Tree, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): Tree;
  fromJSON(object: any): Tree;
  toJSON(message: Tree): unknown;
  create<
    I extends {
      branch?: Uint8Array[] | undefined;
      count?: number | undefined;
    } & {
      branch?:
        | (Uint8Array[] &
            Uint8Array[] & {
              [K in Exclude<keyof I['branch'], keyof Uint8Array[]>]: never;
            })
        | undefined;
      count?: number | undefined;
    } & { [K_1 in Exclude<keyof I, keyof Tree>]: never },
  >(
    base?: I | undefined,
  ): Tree;
  fromPartial<
    I_1 extends {
      branch?: Uint8Array[] | undefined;
      count?: number | undefined;
    } & {
      branch?:
        | (Uint8Array[] &
            Uint8Array[] & {
              [K_2 in Exclude<keyof I_1['branch'], keyof Uint8Array[]>]: never;
            })
        | undefined;
      count?: number | undefined;
    } & { [K_3 in Exclude<keyof I_1, keyof Tree>]: never },
  >(
    object: I_1,
  ): Tree;
};
export declare const NoopHook: {
  encode(message: NoopHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): NoopHook;
  fromJSON(object: any): NoopHook;
  toJSON(message: NoopHook): unknown;
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
    } & { [K in Exclude<keyof I, keyof NoopHook>]: never },
  >(
    base?: I | undefined,
  ): NoopHook;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof NoopHook>]: never },
  >(
    object: I_1,
  ): NoopHook;
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
