import _m0 from 'protobufjs/minimal.js';

import {
  GasOracle,
  InterchainGasPaymaster,
  MerkleTreeHook,
  NoopHook,
} from './types.js';

export declare const protobufPackage = 'hyperlane.core.post_dispatch.v1';
/** GenesisState defines the post dispatch submodule's genesis state. */
export interface GenesisState {
  igps: InterchainGasPaymaster[];
  igp_gas_configs: GenesisDestinationGasConfigWrapper[];
  merkle_tree_hooks: MerkleTreeHook[];
  noop_hooks: NoopHook[];
}
/** GenesisDestinationGasConfigWrapper ... */
export interface GenesisDestinationGasConfigWrapper {
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
  create<
    I extends {
      igps?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            denom?: string | undefined;
            claimable_fees?:
              | {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              | undefined;
          }[]
        | undefined;
      igp_gas_configs?:
        | {
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
            igp_id?: string | undefined;
          }[]
        | undefined;
      merkle_tree_hooks?:
        | {
            id?: string | undefined;
            mailbox_id?: string | undefined;
            owner?: string | undefined;
            tree?:
              | {
                  branch?: Uint8Array[] | undefined;
                  count?: number | undefined;
                }
              | undefined;
          }[]
        | undefined;
      noop_hooks?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
          }[]
        | undefined;
    } & {
      igps?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            denom?: string | undefined;
            claimable_fees?:
              | {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              | undefined;
          }[] &
            ({
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
                        keyof I['igps'][number]['claimable_fees'][number],
                        keyof import('../../../../cosmos/base/v1beta1/coin.js').Coin
                      >]: never;
                    })[] & {
                      [K_1 in Exclude<
                        keyof I['igps'][number]['claimable_fees'],
                        keyof {
                          denom?: string | undefined;
                          amount?: string | undefined;
                        }[]
                      >]: never;
                    })
                | undefined;
            } & {
              [K_2 in Exclude<
                keyof I['igps'][number],
                keyof InterchainGasPaymaster
              >]: never;
            })[] & {
              [K_3 in Exclude<
                keyof I['igps'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  denom?: string | undefined;
                  claimable_fees?:
                    | {
                        denom?: string | undefined;
                        amount?: string | undefined;
                      }[]
                    | undefined;
                }[]
              >]: never;
            })
        | undefined;
      igp_gas_configs?:
        | ({
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
            igp_id?: string | undefined;
          }[] &
            ({
              remote_domain?: number | undefined;
              gas_oracle?:
                | {
                    token_exchange_rate?: string | undefined;
                    gas_price?: string | undefined;
                  }
                | undefined;
              gas_overhead?: string | undefined;
              igp_id?: string | undefined;
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
                    [K_4 in Exclude<
                      keyof I['igp_gas_configs'][number]['gas_oracle'],
                      keyof GasOracle
                    >]: never;
                  })
                | undefined;
              gas_overhead?: string | undefined;
              igp_id?: string | undefined;
            } & {
              [K_5 in Exclude<
                keyof I['igp_gas_configs'][number],
                keyof GenesisDestinationGasConfigWrapper
              >]: never;
            })[] & {
              [K_6 in Exclude<
                keyof I['igp_gas_configs'],
                keyof {
                  remote_domain?: number | undefined;
                  gas_oracle?:
                    | {
                        token_exchange_rate?: string | undefined;
                        gas_price?: string | undefined;
                      }
                    | undefined;
                  gas_overhead?: string | undefined;
                  igp_id?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      merkle_tree_hooks?:
        | ({
            id?: string | undefined;
            mailbox_id?: string | undefined;
            owner?: string | undefined;
            tree?:
              | {
                  branch?: Uint8Array[] | undefined;
                  count?: number | undefined;
                }
              | undefined;
          }[] &
            ({
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
                            [K_7 in Exclude<
                              keyof I['merkle_tree_hooks'][number]['tree']['branch'],
                              keyof Uint8Array[]
                            >]: never;
                          })
                      | undefined;
                    count?: number | undefined;
                  } & {
                    [K_8 in Exclude<
                      keyof I['merkle_tree_hooks'][number]['tree'],
                      keyof import('./types.js').Tree
                    >]: never;
                  })
                | undefined;
            } & {
              [K_9 in Exclude<
                keyof I['merkle_tree_hooks'][number],
                keyof MerkleTreeHook
              >]: never;
            })[] & {
              [K_10 in Exclude<
                keyof I['merkle_tree_hooks'],
                keyof {
                  id?: string | undefined;
                  mailbox_id?: string | undefined;
                  owner?: string | undefined;
                  tree?:
                    | {
                        branch?: Uint8Array[] | undefined;
                        count?: number | undefined;
                      }
                    | undefined;
                }[]
              >]: never;
            })
        | undefined;
      noop_hooks?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
            } & {
              [K_11 in Exclude<
                keyof I['noop_hooks'][number],
                keyof NoopHook
              >]: never;
            })[] & {
              [K_12 in Exclude<
                keyof I['noop_hooks'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_13 in Exclude<keyof I, keyof GenesisState>]: never },
  >(
    base?: I | undefined,
  ): GenesisState;
  fromPartial<
    I_1 extends {
      igps?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            denom?: string | undefined;
            claimable_fees?:
              | {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              | undefined;
          }[]
        | undefined;
      igp_gas_configs?:
        | {
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
            igp_id?: string | undefined;
          }[]
        | undefined;
      merkle_tree_hooks?:
        | {
            id?: string | undefined;
            mailbox_id?: string | undefined;
            owner?: string | undefined;
            tree?:
              | {
                  branch?: Uint8Array[] | undefined;
                  count?: number | undefined;
                }
              | undefined;
          }[]
        | undefined;
      noop_hooks?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
          }[]
        | undefined;
    } & {
      igps?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            denom?: string | undefined;
            claimable_fees?:
              | {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              | undefined;
          }[] &
            ({
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
                      [K_14 in Exclude<
                        keyof I_1['igps'][number]['claimable_fees'][number],
                        keyof import('../../../../cosmos/base/v1beta1/coin.js').Coin
                      >]: never;
                    })[] & {
                      [K_15 in Exclude<
                        keyof I_1['igps'][number]['claimable_fees'],
                        keyof {
                          denom?: string | undefined;
                          amount?: string | undefined;
                        }[]
                      >]: never;
                    })
                | undefined;
            } & {
              [K_16 in Exclude<
                keyof I_1['igps'][number],
                keyof InterchainGasPaymaster
              >]: never;
            })[] & {
              [K_17 in Exclude<
                keyof I_1['igps'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  denom?: string | undefined;
                  claimable_fees?:
                    | {
                        denom?: string | undefined;
                        amount?: string | undefined;
                      }[]
                    | undefined;
                }[]
              >]: never;
            })
        | undefined;
      igp_gas_configs?:
        | ({
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
            igp_id?: string | undefined;
          }[] &
            ({
              remote_domain?: number | undefined;
              gas_oracle?:
                | {
                    token_exchange_rate?: string | undefined;
                    gas_price?: string | undefined;
                  }
                | undefined;
              gas_overhead?: string | undefined;
              igp_id?: string | undefined;
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
                    [K_18 in Exclude<
                      keyof I_1['igp_gas_configs'][number]['gas_oracle'],
                      keyof GasOracle
                    >]: never;
                  })
                | undefined;
              gas_overhead?: string | undefined;
              igp_id?: string | undefined;
            } & {
              [K_19 in Exclude<
                keyof I_1['igp_gas_configs'][number],
                keyof GenesisDestinationGasConfigWrapper
              >]: never;
            })[] & {
              [K_20 in Exclude<
                keyof I_1['igp_gas_configs'],
                keyof {
                  remote_domain?: number | undefined;
                  gas_oracle?:
                    | {
                        token_exchange_rate?: string | undefined;
                        gas_price?: string | undefined;
                      }
                    | undefined;
                  gas_overhead?: string | undefined;
                  igp_id?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      merkle_tree_hooks?:
        | ({
            id?: string | undefined;
            mailbox_id?: string | undefined;
            owner?: string | undefined;
            tree?:
              | {
                  branch?: Uint8Array[] | undefined;
                  count?: number | undefined;
                }
              | undefined;
          }[] &
            ({
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
                            [K_21 in Exclude<
                              keyof I_1['merkle_tree_hooks'][number]['tree']['branch'],
                              keyof Uint8Array[]
                            >]: never;
                          })
                      | undefined;
                    count?: number | undefined;
                  } & {
                    [K_22 in Exclude<
                      keyof I_1['merkle_tree_hooks'][number]['tree'],
                      keyof import('./types.js').Tree
                    >]: never;
                  })
                | undefined;
            } & {
              [K_23 in Exclude<
                keyof I_1['merkle_tree_hooks'][number],
                keyof MerkleTreeHook
              >]: never;
            })[] & {
              [K_24 in Exclude<
                keyof I_1['merkle_tree_hooks'],
                keyof {
                  id?: string | undefined;
                  mailbox_id?: string | undefined;
                  owner?: string | undefined;
                  tree?:
                    | {
                        branch?: Uint8Array[] | undefined;
                        count?: number | undefined;
                      }
                    | undefined;
                }[]
              >]: never;
            })
        | undefined;
      noop_hooks?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
            } & {
              [K_25 in Exclude<
                keyof I_1['noop_hooks'][number],
                keyof NoopHook
              >]: never;
            })[] & {
              [K_26 in Exclude<
                keyof I_1['noop_hooks'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_27 in Exclude<keyof I_1, keyof GenesisState>]: never },
  >(
    object: I_1,
  ): GenesisState;
};
export declare const GenesisDestinationGasConfigWrapper: {
  encode(
    message: GenesisDestinationGasConfigWrapper,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): GenesisDestinationGasConfigWrapper;
  fromJSON(object: any): GenesisDestinationGasConfigWrapper;
  toJSON(message: GenesisDestinationGasConfigWrapper): unknown;
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
      igp_id?: string | undefined;
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
      igp_id?: string | undefined;
    } & {
      [K_1 in Exclude<
        keyof I,
        keyof GenesisDestinationGasConfigWrapper
      >]: never;
    },
  >(
    base?: I | undefined,
  ): GenesisDestinationGasConfigWrapper;
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
      igp_id?: string | undefined;
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
      igp_id?: string | undefined;
    } & {
      [K_3 in Exclude<
        keyof I_1,
        keyof GenesisDestinationGasConfigWrapper
      >]: never;
    },
  >(
    object: I_1,
  ): GenesisDestinationGasConfigWrapper;
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
