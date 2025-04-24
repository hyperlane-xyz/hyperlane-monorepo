import _m0 from 'protobufjs/minimal.js';

import {
  PageRequest,
  PageResponse,
} from '../../../../cosmos/base/query/v1beta1/pagination.js';
import { Coin } from '../../../../cosmos/base/v1beta1/coin.js';

import {
  DestinationGasConfig,
  InterchainGasPaymaster,
  NoopHook,
} from './types.js';

export declare const protobufPackage = 'hyperlane.core.post_dispatch.v1';
/** QueryIgpsRequest ... */
export interface QueryIgpsRequest {
  /** pagination defines an optional pagination for the request. */
  pagination?: PageRequest | undefined;
}
/** QueryIgpsResponse ... */
export interface QueryIgpsResponse {
  igps: InterchainGasPaymaster[];
  /** pagination defines the pagination in the response. */
  pagination?: PageResponse | undefined;
}
/** QueryIgpRequest ... */
export interface QueryIgpRequest {
  id: string;
}
/** QueryIgpResponse ... */
export interface QueryIgpResponse {
  igp?: InterchainGasPaymaster | undefined;
}
/** QueryDestinationGasConfigsRequest ... */
export interface QueryDestinationGasConfigsRequest {
  id: string;
  /** pagination defines an optional pagination for the request. */
  pagination?: PageRequest | undefined;
}
/** QueryDestinationGasConfigsResponse ... */
export interface QueryDestinationGasConfigsResponse {
  destination_gas_configs: DestinationGasConfig[];
  /** pagination defines the pagination in the response. */
  pagination?: PageResponse | undefined;
}
/** QueryQuoteGasPaymentRequest ... */
export interface QueryQuoteGasPaymentRequest {
  igp_id: string;
  destination_domain: string;
  gas_limit: string;
}
/** QueryQuoteGasPaymentResponse ... */
export interface QueryQuoteGasPaymentResponse {
  gas_payment: Coin[];
}
/** QueryMerkleTreeHooksRequest ... */
export interface QueryMerkleTreeHooksRequest {
  pagination?: PageRequest | undefined;
}
/** QueryMerkleTreeHooksResponse ... */
export interface QueryMerkleTreeHooksResponse {
  merkle_tree_hooks: WrappedMerkleTreeHookResponse[];
  pagination?: PageResponse | undefined;
}
/** QueryMerkleTreeHookRequest ... */
export interface QueryMerkleTreeHookRequest {
  id: string;
}
/** QueryMerkleTreeHookResponse */
export interface QueryMerkleTreeHookResponse {
  merkle_tree_hook?: WrappedMerkleTreeHookResponse | undefined;
}
/** WrappedMerkleTreeHookResponse */
export interface WrappedMerkleTreeHookResponse {
  id: string;
  owner: string;
  mailbox_id: string;
  merkle_tree?: TreeResponse | undefined;
}
/** TreeResponse */
export interface TreeResponse {
  /** leafs ... */
  leafs: Uint8Array[];
  /** count ... */
  count: number;
  /** root ... */
  root: Uint8Array;
}
/** QueryNoopHookRequest ... */
export interface QueryNoopHookRequest {
  id: string;
}
/** QueryNoopHookResponse ... */
export interface QueryNoopHookResponse {
  noop_hook?: NoopHook | undefined;
}
/** QueryNoopHooksRequest ... */
export interface QueryNoopHooksRequest {
  pagination?: PageRequest | undefined;
}
/** QueryNoopHooksResponse ... */
export interface QueryNoopHooksResponse {
  noop_hooks: NoopHook[];
  pagination?: PageResponse | undefined;
}
export declare const QueryIgpsRequest: {
  encode(message: QueryIgpsRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIgpsRequest;
  fromJSON(object: any): QueryIgpsRequest;
  toJSON(message: QueryIgpsRequest): unknown;
  create<
    I extends {
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K in Exclude<keyof I['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'pagination'>]: never },
  >(
    base?: I | undefined,
  ): QueryIgpsRequest;
  fromPartial<
    I_1 extends {
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'pagination'>]: never },
  >(
    object: I_1,
  ): QueryIgpsRequest;
};
export declare const QueryIgpsResponse: {
  encode(message: QueryIgpsResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIgpsResponse;
  fromJSON(object: any): QueryIgpsResponse;
  toJSON(message: QueryIgpsResponse): unknown;
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
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
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
                        keyof Coin
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
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_4 in Exclude<keyof I['pagination'], keyof PageResponse>]: never;
          })
        | undefined;
    } & { [K_5 in Exclude<keyof I, keyof QueryIgpsResponse>]: never },
  >(
    base?: I | undefined,
  ): QueryIgpsResponse;
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
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
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
                      [K_6 in Exclude<
                        keyof I_1['igps'][number]['claimable_fees'][number],
                        keyof Coin
                      >]: never;
                    })[] & {
                      [K_7 in Exclude<
                        keyof I_1['igps'][number]['claimable_fees'],
                        keyof {
                          denom?: string | undefined;
                          amount?: string | undefined;
                        }[]
                      >]: never;
                    })
                | undefined;
            } & {
              [K_8 in Exclude<
                keyof I_1['igps'][number],
                keyof InterchainGasPaymaster
              >]: never;
            })[] & {
              [K_9 in Exclude<
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
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_10 in Exclude<
              keyof I_1['pagination'],
              keyof PageResponse
            >]: never;
          })
        | undefined;
    } & { [K_11 in Exclude<keyof I_1, keyof QueryIgpsResponse>]: never },
  >(
    object: I_1,
  ): QueryIgpsResponse;
};
export declare const QueryIgpRequest: {
  encode(message: QueryIgpRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIgpRequest;
  fromJSON(object: any): QueryIgpRequest;
  toJSON(message: QueryIgpRequest): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): QueryIgpRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): QueryIgpRequest;
};
export declare const QueryIgpResponse: {
  encode(message: QueryIgpResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryIgpResponse;
  fromJSON(object: any): QueryIgpResponse;
  toJSON(message: QueryIgpResponse): unknown;
  create<
    I extends {
      igp?:
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
          }
        | undefined;
    } & {
      igp?:
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
                      keyof I['igp']['claimable_fees'][number],
                      keyof Coin
                    >]: never;
                  })[] & {
                    [K_1 in Exclude<
                      keyof I['igp']['claimable_fees'],
                      keyof {
                        denom?: string | undefined;
                        amount?: string | undefined;
                      }[]
                    >]: never;
                  })
              | undefined;
          } & {
            [K_2 in Exclude<
              keyof I['igp'],
              keyof InterchainGasPaymaster
            >]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I, 'igp'>]: never },
  >(
    base?: I | undefined,
  ): QueryIgpResponse;
  fromPartial<
    I_1 extends {
      igp?:
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
          }
        | undefined;
    } & {
      igp?:
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
                    [K_4 in Exclude<
                      keyof I_1['igp']['claimable_fees'][number],
                      keyof Coin
                    >]: never;
                  })[] & {
                    [K_5 in Exclude<
                      keyof I_1['igp']['claimable_fees'],
                      keyof {
                        denom?: string | undefined;
                        amount?: string | undefined;
                      }[]
                    >]: never;
                  })
              | undefined;
          } & {
            [K_6 in Exclude<
              keyof I_1['igp'],
              keyof InterchainGasPaymaster
            >]: never;
          })
        | undefined;
    } & { [K_7 in Exclude<keyof I_1, 'igp'>]: never },
  >(
    object: I_1,
  ): QueryIgpResponse;
};
export declare const QueryDestinationGasConfigsRequest: {
  encode(
    message: QueryDestinationGasConfigsRequest,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryDestinationGasConfigsRequest;
  fromJSON(object: any): QueryDestinationGasConfigsRequest;
  toJSON(message: QueryDestinationGasConfigsRequest): unknown;
  create<
    I extends {
      id?: string | undefined;
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      id?: string | undefined;
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K in Exclude<keyof I['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & {
      [K_1 in Exclude<keyof I, keyof QueryDestinationGasConfigsRequest>]: never;
    },
  >(
    base?: I | undefined,
  ): QueryDestinationGasConfigsRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      id?: string | undefined;
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & {
      [K_3 in Exclude<
        keyof I_1,
        keyof QueryDestinationGasConfigsRequest
      >]: never;
    },
  >(
    object: I_1,
  ): QueryDestinationGasConfigsRequest;
};
export declare const QueryDestinationGasConfigsResponse: {
  encode(
    message: QueryDestinationGasConfigsResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryDestinationGasConfigsResponse;
  fromJSON(object: any): QueryDestinationGasConfigsResponse;
  toJSON(message: QueryDestinationGasConfigsResponse): unknown;
  create<
    I extends {
      destination_gas_configs?:
        | {
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      destination_gas_configs?:
        | ({
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
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
                    [K in Exclude<
                      keyof I['destination_gas_configs'][number]['gas_oracle'],
                      keyof import('./types.js').GasOracle
                    >]: never;
                  })
                | undefined;
              gas_overhead?: string | undefined;
            } & {
              [K_1 in Exclude<
                keyof I['destination_gas_configs'][number],
                keyof DestinationGasConfig
              >]: never;
            })[] & {
              [K_2 in Exclude<
                keyof I['destination_gas_configs'],
                keyof {
                  remote_domain?: number | undefined;
                  gas_oracle?:
                    | {
                        token_exchange_rate?: string | undefined;
                        gas_price?: string | undefined;
                      }
                    | undefined;
                  gas_overhead?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_3 in Exclude<keyof I['pagination'], keyof PageResponse>]: never;
          })
        | undefined;
    } & {
      [K_4 in Exclude<
        keyof I,
        keyof QueryDestinationGasConfigsResponse
      >]: never;
    },
  >(
    base?: I | undefined,
  ): QueryDestinationGasConfigsResponse;
  fromPartial<
    I_1 extends {
      destination_gas_configs?:
        | {
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      destination_gas_configs?:
        | ({
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
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
                    [K_5 in Exclude<
                      keyof I_1['destination_gas_configs'][number]['gas_oracle'],
                      keyof import('./types.js').GasOracle
                    >]: never;
                  })
                | undefined;
              gas_overhead?: string | undefined;
            } & {
              [K_6 in Exclude<
                keyof I_1['destination_gas_configs'][number],
                keyof DestinationGasConfig
              >]: never;
            })[] & {
              [K_7 in Exclude<
                keyof I_1['destination_gas_configs'],
                keyof {
                  remote_domain?: number | undefined;
                  gas_oracle?:
                    | {
                        token_exchange_rate?: string | undefined;
                        gas_price?: string | undefined;
                      }
                    | undefined;
                  gas_overhead?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_8 in Exclude<
              keyof I_1['pagination'],
              keyof PageResponse
            >]: never;
          })
        | undefined;
    } & {
      [K_9 in Exclude<
        keyof I_1,
        keyof QueryDestinationGasConfigsResponse
      >]: never;
    },
  >(
    object: I_1,
  ): QueryDestinationGasConfigsResponse;
};
export declare const QueryQuoteGasPaymentRequest: {
  encode(message: QueryQuoteGasPaymentRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryQuoteGasPaymentRequest;
  fromJSON(object: any): QueryQuoteGasPaymentRequest;
  toJSON(message: QueryQuoteGasPaymentRequest): unknown;
  create<
    I extends {
      igp_id?: string | undefined;
      destination_domain?: string | undefined;
      gas_limit?: string | undefined;
    } & {
      igp_id?: string | undefined;
      destination_domain?: string | undefined;
      gas_limit?: string | undefined;
    } & { [K in Exclude<keyof I, keyof QueryQuoteGasPaymentRequest>]: never },
  >(
    base?: I | undefined,
  ): QueryQuoteGasPaymentRequest;
  fromPartial<
    I_1 extends {
      igp_id?: string | undefined;
      destination_domain?: string | undefined;
      gas_limit?: string | undefined;
    } & {
      igp_id?: string | undefined;
      destination_domain?: string | undefined;
      gas_limit?: string | undefined;
    } & {
      [K_1 in Exclude<keyof I_1, keyof QueryQuoteGasPaymentRequest>]: never;
    },
  >(
    object: I_1,
  ): QueryQuoteGasPaymentRequest;
};
export declare const QueryQuoteGasPaymentResponse: {
  encode(
    message: QueryQuoteGasPaymentResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryQuoteGasPaymentResponse;
  fromJSON(object: any): QueryQuoteGasPaymentResponse;
  toJSON(message: QueryQuoteGasPaymentResponse): unknown;
  create<
    I extends {
      gas_payment?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }[]
        | undefined;
    } & {
      gas_payment?:
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
              [K in Exclude<keyof I['gas_payment'][number], keyof Coin>]: never;
            })[] & {
              [K_1 in Exclude<
                keyof I['gas_payment'],
                keyof {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_2 in Exclude<keyof I, 'gas_payment'>]: never },
  >(
    base?: I | undefined,
  ): QueryQuoteGasPaymentResponse;
  fromPartial<
    I_1 extends {
      gas_payment?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }[]
        | undefined;
    } & {
      gas_payment?:
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
                keyof I_1['gas_payment'][number],
                keyof Coin
              >]: never;
            })[] & {
              [K_4 in Exclude<
                keyof I_1['gas_payment'],
                keyof {
                  denom?: string | undefined;
                  amount?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
    } & { [K_5 in Exclude<keyof I_1, 'gas_payment'>]: never },
  >(
    object: I_1,
  ): QueryQuoteGasPaymentResponse;
};
export declare const QueryMerkleTreeHooksRequest: {
  encode(message: QueryMerkleTreeHooksRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryMerkleTreeHooksRequest;
  fromJSON(object: any): QueryMerkleTreeHooksRequest;
  toJSON(message: QueryMerkleTreeHooksRequest): unknown;
  create<
    I extends {
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K in Exclude<keyof I['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'pagination'>]: never },
  >(
    base?: I | undefined,
  ): QueryMerkleTreeHooksRequest;
  fromPartial<
    I_1 extends {
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'pagination'>]: never },
  >(
    object: I_1,
  ): QueryMerkleTreeHooksRequest;
};
export declare const QueryMerkleTreeHooksResponse: {
  encode(
    message: QueryMerkleTreeHooksResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryMerkleTreeHooksResponse;
  fromJSON(object: any): QueryMerkleTreeHooksResponse;
  toJSON(message: QueryMerkleTreeHooksResponse): unknown;
  create<
    I extends {
      merkle_tree_hooks?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | {
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                }
              | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      merkle_tree_hooks?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | {
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                }
              | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              mailbox_id?: string | undefined;
              merkle_tree?:
                | {
                    leafs?: Uint8Array[] | undefined;
                    count?: number | undefined;
                    root?: Uint8Array | undefined;
                  }
                | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              mailbox_id?: string | undefined;
              merkle_tree?:
                | ({
                    leafs?: Uint8Array[] | undefined;
                    count?: number | undefined;
                    root?: Uint8Array | undefined;
                  } & {
                    leafs?:
                      | (Uint8Array[] &
                          Uint8Array[] & {
                            [K in Exclude<
                              keyof I['merkle_tree_hooks'][number]['merkle_tree']['leafs'],
                              keyof Uint8Array[]
                            >]: never;
                          })
                      | undefined;
                    count?: number | undefined;
                    root?: Uint8Array | undefined;
                  } & {
                    [K_1 in Exclude<
                      keyof I['merkle_tree_hooks'][number]['merkle_tree'],
                      keyof TreeResponse
                    >]: never;
                  })
                | undefined;
            } & {
              [K_2 in Exclude<
                keyof I['merkle_tree_hooks'][number],
                keyof WrappedMerkleTreeHookResponse
              >]: never;
            })[] & {
              [K_3 in Exclude<
                keyof I['merkle_tree_hooks'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  mailbox_id?: string | undefined;
                  merkle_tree?:
                    | {
                        leafs?: Uint8Array[] | undefined;
                        count?: number | undefined;
                        root?: Uint8Array | undefined;
                      }
                    | undefined;
                }[]
              >]: never;
            })
        | undefined;
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_4 in Exclude<keyof I['pagination'], keyof PageResponse>]: never;
          })
        | undefined;
    } & {
      [K_5 in Exclude<keyof I, keyof QueryMerkleTreeHooksResponse>]: never;
    },
  >(
    base?: I | undefined,
  ): QueryMerkleTreeHooksResponse;
  fromPartial<
    I_1 extends {
      merkle_tree_hooks?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | {
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                }
              | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
      merkle_tree_hooks?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | {
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                }
              | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              mailbox_id?: string | undefined;
              merkle_tree?:
                | {
                    leafs?: Uint8Array[] | undefined;
                    count?: number | undefined;
                    root?: Uint8Array | undefined;
                  }
                | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              mailbox_id?: string | undefined;
              merkle_tree?:
                | ({
                    leafs?: Uint8Array[] | undefined;
                    count?: number | undefined;
                    root?: Uint8Array | undefined;
                  } & {
                    leafs?:
                      | (Uint8Array[] &
                          Uint8Array[] & {
                            [K_6 in Exclude<
                              keyof I_1['merkle_tree_hooks'][number]['merkle_tree']['leafs'],
                              keyof Uint8Array[]
                            >]: never;
                          })
                      | undefined;
                    count?: number | undefined;
                    root?: Uint8Array | undefined;
                  } & {
                    [K_7 in Exclude<
                      keyof I_1['merkle_tree_hooks'][number]['merkle_tree'],
                      keyof TreeResponse
                    >]: never;
                  })
                | undefined;
            } & {
              [K_8 in Exclude<
                keyof I_1['merkle_tree_hooks'][number],
                keyof WrappedMerkleTreeHookResponse
              >]: never;
            })[] & {
              [K_9 in Exclude<
                keyof I_1['merkle_tree_hooks'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  mailbox_id?: string | undefined;
                  merkle_tree?:
                    | {
                        leafs?: Uint8Array[] | undefined;
                        count?: number | undefined;
                        root?: Uint8Array | undefined;
                      }
                    | undefined;
                }[]
              >]: never;
            })
        | undefined;
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_10 in Exclude<
              keyof I_1['pagination'],
              keyof PageResponse
            >]: never;
          })
        | undefined;
    } & {
      [K_11 in Exclude<keyof I_1, keyof QueryMerkleTreeHooksResponse>]: never;
    },
  >(
    object: I_1,
  ): QueryMerkleTreeHooksResponse;
};
export declare const QueryMerkleTreeHookRequest: {
  encode(message: QueryMerkleTreeHookRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryMerkleTreeHookRequest;
  fromJSON(object: any): QueryMerkleTreeHookRequest;
  toJSON(message: QueryMerkleTreeHookRequest): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): QueryMerkleTreeHookRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): QueryMerkleTreeHookRequest;
};
export declare const QueryMerkleTreeHookResponse: {
  encode(message: QueryMerkleTreeHookResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryMerkleTreeHookResponse;
  fromJSON(object: any): QueryMerkleTreeHookResponse;
  toJSON(message: QueryMerkleTreeHookResponse): unknown;
  create<
    I extends {
      merkle_tree_hook?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | {
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                }
              | undefined;
          }
        | undefined;
    } & {
      merkle_tree_hook?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | {
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                }
              | undefined;
          } & {
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | ({
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                } & {
                  leafs?:
                    | (Uint8Array[] &
                        Uint8Array[] & {
                          [K in Exclude<
                            keyof I['merkle_tree_hook']['merkle_tree']['leafs'],
                            keyof Uint8Array[]
                          >]: never;
                        })
                    | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                } & {
                  [K_1 in Exclude<
                    keyof I['merkle_tree_hook']['merkle_tree'],
                    keyof TreeResponse
                  >]: never;
                })
              | undefined;
          } & {
            [K_2 in Exclude<
              keyof I['merkle_tree_hook'],
              keyof WrappedMerkleTreeHookResponse
            >]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I, 'merkle_tree_hook'>]: never },
  >(
    base?: I | undefined,
  ): QueryMerkleTreeHookResponse;
  fromPartial<
    I_1 extends {
      merkle_tree_hook?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | {
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                }
              | undefined;
          }
        | undefined;
    } & {
      merkle_tree_hook?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | {
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                }
              | undefined;
          } & {
            id?: string | undefined;
            owner?: string | undefined;
            mailbox_id?: string | undefined;
            merkle_tree?:
              | ({
                  leafs?: Uint8Array[] | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                } & {
                  leafs?:
                    | (Uint8Array[] &
                        Uint8Array[] & {
                          [K_4 in Exclude<
                            keyof I_1['merkle_tree_hook']['merkle_tree']['leafs'],
                            keyof Uint8Array[]
                          >]: never;
                        })
                    | undefined;
                  count?: number | undefined;
                  root?: Uint8Array | undefined;
                } & {
                  [K_5 in Exclude<
                    keyof I_1['merkle_tree_hook']['merkle_tree'],
                    keyof TreeResponse
                  >]: never;
                })
              | undefined;
          } & {
            [K_6 in Exclude<
              keyof I_1['merkle_tree_hook'],
              keyof WrappedMerkleTreeHookResponse
            >]: never;
          })
        | undefined;
    } & { [K_7 in Exclude<keyof I_1, 'merkle_tree_hook'>]: never },
  >(
    object: I_1,
  ): QueryMerkleTreeHookResponse;
};
export declare const WrappedMerkleTreeHookResponse: {
  encode(
    message: WrappedMerkleTreeHookResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): WrappedMerkleTreeHookResponse;
  fromJSON(object: any): WrappedMerkleTreeHookResponse;
  toJSON(message: WrappedMerkleTreeHookResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
      mailbox_id?: string | undefined;
      merkle_tree?:
        | {
            leafs?: Uint8Array[] | undefined;
            count?: number | undefined;
            root?: Uint8Array | undefined;
          }
        | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      mailbox_id?: string | undefined;
      merkle_tree?:
        | ({
            leafs?: Uint8Array[] | undefined;
            count?: number | undefined;
            root?: Uint8Array | undefined;
          } & {
            leafs?:
              | (Uint8Array[] &
                  Uint8Array[] & {
                    [K in Exclude<
                      keyof I['merkle_tree']['leafs'],
                      keyof Uint8Array[]
                    >]: never;
                  })
              | undefined;
            count?: number | undefined;
            root?: Uint8Array | undefined;
          } & {
            [K_1 in Exclude<keyof I['merkle_tree'], keyof TreeResponse>]: never;
          })
        | undefined;
    } & {
      [K_2 in Exclude<keyof I, keyof WrappedMerkleTreeHookResponse>]: never;
    },
  >(
    base?: I | undefined,
  ): WrappedMerkleTreeHookResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
      mailbox_id?: string | undefined;
      merkle_tree?:
        | {
            leafs?: Uint8Array[] | undefined;
            count?: number | undefined;
            root?: Uint8Array | undefined;
          }
        | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      mailbox_id?: string | undefined;
      merkle_tree?:
        | ({
            leafs?: Uint8Array[] | undefined;
            count?: number | undefined;
            root?: Uint8Array | undefined;
          } & {
            leafs?:
              | (Uint8Array[] &
                  Uint8Array[] & {
                    [K_3 in Exclude<
                      keyof I_1['merkle_tree']['leafs'],
                      keyof Uint8Array[]
                    >]: never;
                  })
              | undefined;
            count?: number | undefined;
            root?: Uint8Array | undefined;
          } & {
            [K_4 in Exclude<
              keyof I_1['merkle_tree'],
              keyof TreeResponse
            >]: never;
          })
        | undefined;
    } & {
      [K_5 in Exclude<keyof I_1, keyof WrappedMerkleTreeHookResponse>]: never;
    },
  >(
    object: I_1,
  ): WrappedMerkleTreeHookResponse;
};
export declare const TreeResponse: {
  encode(message: TreeResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): TreeResponse;
  fromJSON(object: any): TreeResponse;
  toJSON(message: TreeResponse): unknown;
  create<
    I extends {
      leafs?: Uint8Array[] | undefined;
      count?: number | undefined;
      root?: Uint8Array | undefined;
    } & {
      leafs?:
        | (Uint8Array[] &
            Uint8Array[] & {
              [K in Exclude<keyof I['leafs'], keyof Uint8Array[]>]: never;
            })
        | undefined;
      count?: number | undefined;
      root?: Uint8Array | undefined;
    } & { [K_1 in Exclude<keyof I, keyof TreeResponse>]: never },
  >(
    base?: I | undefined,
  ): TreeResponse;
  fromPartial<
    I_1 extends {
      leafs?: Uint8Array[] | undefined;
      count?: number | undefined;
      root?: Uint8Array | undefined;
    } & {
      leafs?:
        | (Uint8Array[] &
            Uint8Array[] & {
              [K_2 in Exclude<keyof I_1['leafs'], keyof Uint8Array[]>]: never;
            })
        | undefined;
      count?: number | undefined;
      root?: Uint8Array | undefined;
    } & { [K_3 in Exclude<keyof I_1, keyof TreeResponse>]: never },
  >(
    object: I_1,
  ): TreeResponse;
};
export declare const QueryNoopHookRequest: {
  encode(message: QueryNoopHookRequest, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): QueryNoopHookRequest;
  fromJSON(object: any): QueryNoopHookRequest;
  toJSON(message: QueryNoopHookRequest): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): QueryNoopHookRequest;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): QueryNoopHookRequest;
};
export declare const QueryNoopHookResponse: {
  encode(message: QueryNoopHookResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryNoopHookResponse;
  fromJSON(object: any): QueryNoopHookResponse;
  toJSON(message: QueryNoopHookResponse): unknown;
  create<
    I extends {
      noop_hook?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
          }
        | undefined;
    } & {
      noop_hook?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
          } & {
            id?: string | undefined;
            owner?: string | undefined;
          } & { [K in Exclude<keyof I['noop_hook'], keyof NoopHook>]: never })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'noop_hook'>]: never },
  >(
    base?: I | undefined,
  ): QueryNoopHookResponse;
  fromPartial<
    I_1 extends {
      noop_hook?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
          }
        | undefined;
    } & {
      noop_hook?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
          } & {
            id?: string | undefined;
            owner?: string | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['noop_hook'], keyof NoopHook>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'noop_hook'>]: never },
  >(
    object: I_1,
  ): QueryNoopHookResponse;
};
export declare const QueryNoopHooksRequest: {
  encode(message: QueryNoopHooksRequest, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryNoopHooksRequest;
  fromJSON(object: any): QueryNoopHooksRequest;
  toJSON(message: QueryNoopHooksRequest): unknown;
  create<
    I extends {
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K in Exclude<keyof I['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & { [K_1 in Exclude<keyof I, 'pagination'>]: never },
  >(
    base?: I | undefined,
  ): QueryNoopHooksRequest;
  fromPartial<
    I_1 extends {
      pagination?:
        | {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          }
        | undefined;
    } & {
      pagination?:
        | ({
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            key?: Uint8Array | undefined;
            offset?: string | undefined;
            limit?: string | undefined;
            count_total?: boolean | undefined;
            reverse?: boolean | undefined;
          } & {
            [K_2 in Exclude<keyof I_1['pagination'], keyof PageRequest>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, 'pagination'>]: never },
  >(
    object: I_1,
  ): QueryNoopHooksRequest;
};
export declare const QueryNoopHooksResponse: {
  encode(message: QueryNoopHooksResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): QueryNoopHooksResponse;
  fromJSON(object: any): QueryNoopHooksResponse;
  toJSON(message: QueryNoopHooksResponse): unknown;
  create<
    I extends {
      noop_hooks?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
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
              [K in Exclude<
                keyof I['noop_hooks'][number],
                keyof NoopHook
              >]: never;
            })[] & {
              [K_1 in Exclude<
                keyof I['noop_hooks'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_2 in Exclude<keyof I['pagination'], keyof PageResponse>]: never;
          })
        | undefined;
    } & { [K_3 in Exclude<keyof I, keyof QueryNoopHooksResponse>]: never },
  >(
    base?: I | undefined,
  ): QueryNoopHooksResponse;
  fromPartial<
    I_1 extends {
      noop_hooks?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
          }[]
        | undefined;
      pagination?:
        | {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          }
        | undefined;
    } & {
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
              [K_4 in Exclude<
                keyof I_1['noop_hooks'][number],
                keyof NoopHook
              >]: never;
            })[] & {
              [K_5 in Exclude<
                keyof I_1['noop_hooks'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      pagination?:
        | ({
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            next_key?: Uint8Array | undefined;
            total?: string | undefined;
          } & {
            [K_6 in Exclude<
              keyof I_1['pagination'],
              keyof PageResponse
            >]: never;
          })
        | undefined;
    } & { [K_7 in Exclude<keyof I_1, keyof QueryNoopHooksResponse>]: never },
  >(
    object: I_1,
  ): QueryNoopHooksResponse;
};
/** Msg defines the module Msg service. */
export interface Query {
  /** Igps ... */
  Igps(request: QueryIgpsRequest): Promise<QueryIgpsResponse>;
  /** Igp ... */
  Igp(request: QueryIgpRequest): Promise<QueryIgpResponse>;
  /** DestinationGasConfigs ... */
  DestinationGasConfigs(
    request: QueryDestinationGasConfigsRequest,
  ): Promise<QueryDestinationGasConfigsResponse>;
  /** QuoteGasPayment ... */
  QuoteGasPayment(
    request: QueryQuoteGasPaymentRequest,
  ): Promise<QueryQuoteGasPaymentResponse>;
  /** MerkleTreeHooks ... */
  MerkleTreeHooks(
    request: QueryMerkleTreeHooksRequest,
  ): Promise<QueryMerkleTreeHooksResponse>;
  /** MerkleTreeHook ... */
  MerkleTreeHook(
    request: QueryMerkleTreeHookRequest,
  ): Promise<QueryMerkleTreeHookResponse>;
  /** NoopHooks ... */
  NoopHooks(request: QueryNoopHooksRequest): Promise<QueryNoopHooksResponse>;
  /** NoopHook ... */
  NoopHook(request: QueryNoopHookRequest): Promise<QueryNoopHookResponse>;
}
export declare const QueryServiceName = 'hyperlane.core.post_dispatch.v1.Query';
export declare class QueryClientImpl implements Query {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  Igps(request: QueryIgpsRequest): Promise<QueryIgpsResponse>;
  Igp(request: QueryIgpRequest): Promise<QueryIgpResponse>;
  DestinationGasConfigs(
    request: QueryDestinationGasConfigsRequest,
  ): Promise<QueryDestinationGasConfigsResponse>;
  QuoteGasPayment(
    request: QueryQuoteGasPaymentRequest,
  ): Promise<QueryQuoteGasPaymentResponse>;
  MerkleTreeHooks(
    request: QueryMerkleTreeHooksRequest,
  ): Promise<QueryMerkleTreeHooksResponse>;
  MerkleTreeHook(
    request: QueryMerkleTreeHookRequest,
  ): Promise<QueryMerkleTreeHookResponse>;
  NoopHooks(request: QueryNoopHooksRequest): Promise<QueryNoopHooksResponse>;
  NoopHook(request: QueryNoopHookRequest): Promise<QueryNoopHookResponse>;
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
//# sourceMappingURL=query.d.ts.map
