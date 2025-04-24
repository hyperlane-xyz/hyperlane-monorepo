import _m0 from 'protobufjs/minimal.js';

import { HypToken, Params, RemoteRouter } from './types.js';

export declare const protobufPackage = 'hyperlane.warp.v1';
/** GenesisState is the state that must be provided at genesis. */
export interface GenesisState {
  params?: Params | undefined;
  tokens: HypToken[];
  remote_routers: GenesisRemoteRouterWrapper[];
}
/** GenesisRemoteRouterWrapper ... */
export interface GenesisRemoteRouterWrapper {
  token_id: string;
  remote_router?: RemoteRouter | undefined;
}
export declare const GenesisState: {
  encode(message: GenesisState, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): GenesisState;
  fromJSON(object: any): GenesisState;
  toJSON(message: GenesisState): unknown;
  create<
    I extends {
      params?: {} | undefined;
      tokens?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: import('./types.js').HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            collateral_balance?: string | undefined;
            ism_id?: string | undefined;
          }[]
        | undefined;
      remote_routers?:
        | {
            token_id?: string | undefined;
            remote_router?:
              | {
                  receiver_domain?: number | undefined;
                  receiver_contract?: string | undefined;
                  gas?: string | undefined;
                }
              | undefined;
          }[]
        | undefined;
    } & {
      params?:
        | ({} & {} & { [K in Exclude<keyof I['params'], never>]: never })
        | undefined;
      tokens?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: import('./types.js').HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            collateral_balance?: string | undefined;
            ism_id?: string | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              token_type?: import('./types.js').HypTokenType | undefined;
              origin_mailbox?: string | undefined;
              origin_denom?: string | undefined;
              collateral_balance?: string | undefined;
              ism_id?: string | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              token_type?: import('./types.js').HypTokenType | undefined;
              origin_mailbox?: string | undefined;
              origin_denom?: string | undefined;
              collateral_balance?: string | undefined;
              ism_id?: string | undefined;
            } & {
              [K_1 in Exclude<
                keyof I['tokens'][number],
                keyof HypToken
              >]: never;
            })[] & {
              [K_2 in Exclude<
                keyof I['tokens'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  token_type?: import('./types.js').HypTokenType | undefined;
                  origin_mailbox?: string | undefined;
                  origin_denom?: string | undefined;
                  collateral_balance?: string | undefined;
                  ism_id?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      remote_routers?:
        | ({
            token_id?: string | undefined;
            remote_router?:
              | {
                  receiver_domain?: number | undefined;
                  receiver_contract?: string | undefined;
                  gas?: string | undefined;
                }
              | undefined;
          }[] &
            ({
              token_id?: string | undefined;
              remote_router?:
                | {
                    receiver_domain?: number | undefined;
                    receiver_contract?: string | undefined;
                    gas?: string | undefined;
                  }
                | undefined;
            } & {
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
                    [K_3 in Exclude<
                      keyof I['remote_routers'][number]['remote_router'],
                      keyof RemoteRouter
                    >]: never;
                  })
                | undefined;
            } & {
              [K_4 in Exclude<
                keyof I['remote_routers'][number],
                keyof GenesisRemoteRouterWrapper
              >]: never;
            })[] & {
              [K_5 in Exclude<
                keyof I['remote_routers'],
                keyof {
                  token_id?: string | undefined;
                  remote_router?:
                    | {
                        receiver_domain?: number | undefined;
                        receiver_contract?: string | undefined;
                        gas?: string | undefined;
                      }
                    | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_6 in Exclude<keyof I, keyof GenesisState>]: never },
  >(
    base?: I | undefined,
  ): GenesisState;
  fromPartial<
    I_1 extends {
      params?: {} | undefined;
      tokens?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: import('./types.js').HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            collateral_balance?: string | undefined;
            ism_id?: string | undefined;
          }[]
        | undefined;
      remote_routers?:
        | {
            token_id?: string | undefined;
            remote_router?:
              | {
                  receiver_domain?: number | undefined;
                  receiver_contract?: string | undefined;
                  gas?: string | undefined;
                }
              | undefined;
          }[]
        | undefined;
    } & {
      params?:
        | ({} & {} & { [K_7 in Exclude<keyof I_1['params'], never>]: never })
        | undefined;
      tokens?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            token_type?: import('./types.js').HypTokenType | undefined;
            origin_mailbox?: string | undefined;
            origin_denom?: string | undefined;
            collateral_balance?: string | undefined;
            ism_id?: string | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              token_type?: import('./types.js').HypTokenType | undefined;
              origin_mailbox?: string | undefined;
              origin_denom?: string | undefined;
              collateral_balance?: string | undefined;
              ism_id?: string | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              token_type?: import('./types.js').HypTokenType | undefined;
              origin_mailbox?: string | undefined;
              origin_denom?: string | undefined;
              collateral_balance?: string | undefined;
              ism_id?: string | undefined;
            } & {
              [K_8 in Exclude<
                keyof I_1['tokens'][number],
                keyof HypToken
              >]: never;
            })[] & {
              [K_9 in Exclude<
                keyof I_1['tokens'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  token_type?: import('./types.js').HypTokenType | undefined;
                  origin_mailbox?: string | undefined;
                  origin_denom?: string | undefined;
                  collateral_balance?: string | undefined;
                  ism_id?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      remote_routers?:
        | ({
            token_id?: string | undefined;
            remote_router?:
              | {
                  receiver_domain?: number | undefined;
                  receiver_contract?: string | undefined;
                  gas?: string | undefined;
                }
              | undefined;
          }[] &
            ({
              token_id?: string | undefined;
              remote_router?:
                | {
                    receiver_domain?: number | undefined;
                    receiver_contract?: string | undefined;
                    gas?: string | undefined;
                  }
                | undefined;
            } & {
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
                    [K_10 in Exclude<
                      keyof I_1['remote_routers'][number]['remote_router'],
                      keyof RemoteRouter
                    >]: never;
                  })
                | undefined;
            } & {
              [K_11 in Exclude<
                keyof I_1['remote_routers'][number],
                keyof GenesisRemoteRouterWrapper
              >]: never;
            })[] & {
              [K_12 in Exclude<
                keyof I_1['remote_routers'],
                keyof {
                  token_id?: string | undefined;
                  remote_router?:
                    | {
                        receiver_domain?: number | undefined;
                        receiver_contract?: string | undefined;
                        gas?: string | undefined;
                      }
                    | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_13 in Exclude<keyof I_1, keyof GenesisState>]: never },
  >(
    object: I_1,
  ): GenesisState;
};
export declare const GenesisRemoteRouterWrapper: {
  encode(message: GenesisRemoteRouterWrapper, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): GenesisRemoteRouterWrapper;
  fromJSON(object: any): GenesisRemoteRouterWrapper;
  toJSON(message: GenesisRemoteRouterWrapper): unknown;
  create<
    I extends {
      token_id?: string | undefined;
      remote_router?:
        | {
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          }
        | undefined;
    } & {
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
    } & { [K_1 in Exclude<keyof I, keyof GenesisRemoteRouterWrapper>]: never },
  >(
    base?: I | undefined,
  ): GenesisRemoteRouterWrapper;
  fromPartial<
    I_1 extends {
      token_id?: string | undefined;
      remote_router?:
        | {
            receiver_domain?: number | undefined;
            receiver_contract?: string | undefined;
            gas?: string | undefined;
          }
        | undefined;
    } & {
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
    } & {
      [K_3 in Exclude<keyof I_1, keyof GenesisRemoteRouterWrapper>]: never;
    },
  >(
    object: I_1,
  ): GenesisRemoteRouterWrapper;
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
