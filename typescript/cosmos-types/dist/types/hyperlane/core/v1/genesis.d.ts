import _m0 from 'protobufjs/minimal.js';

import { GenesisState as GenesisState1 } from '../interchain_security/v1/genesis.js';
import { GenesisState as GenesisState2 } from '../post_dispatch/v1/genesis.js';

import { Mailbox } from './types.js';

export declare const protobufPackage = 'hyperlane.core.v1';
/** GenesisState is the state that must be provided at genesis. */
export interface GenesisState {
  /** ism_genesis */
  ism_genesis?: GenesisState1 | undefined;
  /** post_dispatch_genesis */
  post_dispatch_genesis?: GenesisState2 | undefined;
  mailboxes: Mailbox[];
  messages: GenesisMailboxMessageWrapper[];
  ism_sequence: string;
  post_dispatch_sequence: string;
  app_sequence: string;
}
/** GenesisMailboxMessageWrapper ... */
export interface GenesisMailboxMessageWrapper {
  mailbox_id: string;
  message_id: string;
}
export declare const GenesisState: {
  encode(message: GenesisState, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): GenesisState;
  fromJSON(object: any): GenesisState;
  toJSON(message: GenesisState): unknown;
  create<
    I extends {
      ism_genesis?:
        | {
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
          }
        | undefined;
      post_dispatch_genesis?:
        | {
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
          }
        | undefined;
      mailboxes?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }[]
        | undefined;
      messages?:
        | {
            mailbox_id?: string | undefined;
            message_id?: string | undefined;
          }[]
        | undefined;
      ism_sequence?: string | undefined;
      post_dispatch_sequence?: string | undefined;
      app_sequence?: string | undefined;
    } & {
      ism_genesis?:
        | ({
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
                    [K in Exclude<
                      keyof I['ism_genesis']['isms'][number],
                      keyof import('../../../google/protobuf/any.js').Any
                    >]: never;
                  })[] & {
                    [K_1 in Exclude<
                      keyof I['ism_genesis']['isms'],
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
                      keyof I['ism_genesis']['validator_storage_locations'][number],
                      keyof import('../interchain_security/v1/genesis.js').GenesisValidatorStorageLocationWrapper
                    >]: never;
                  })[] & {
                    [K_3 in Exclude<
                      keyof I['ism_genesis']['validator_storage_locations'],
                      keyof {
                        mailbox_id?: string | undefined;
                        validator_address?: string | undefined;
                        index?: string | undefined;
                        storage_location?: string | undefined;
                      }[]
                    >]: never;
                  })
              | undefined;
          } & {
            [K_4 in Exclude<
              keyof I['ism_genesis'],
              keyof GenesisState1
            >]: never;
          })
        | undefined;
      post_dispatch_genesis?:
        | ({
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
                            [K_5 in Exclude<
                              keyof I['post_dispatch_genesis']['igps'][number]['claimable_fees'][number],
                              keyof import('../../../cosmos/base/v1beta1/coin.js').Coin
                            >]: never;
                          })[] & {
                            [K_6 in Exclude<
                              keyof I['post_dispatch_genesis']['igps'][number]['claimable_fees'],
                              keyof {
                                denom?: string | undefined;
                                amount?: string | undefined;
                              }[]
                            >]: never;
                          })
                      | undefined;
                  } & {
                    [K_7 in Exclude<
                      keyof I['post_dispatch_genesis']['igps'][number],
                      keyof import('../post_dispatch/v1/types.js').InterchainGasPaymaster
                    >]: never;
                  })[] & {
                    [K_8 in Exclude<
                      keyof I['post_dispatch_genesis']['igps'],
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
                          [K_9 in Exclude<
                            keyof I['post_dispatch_genesis']['igp_gas_configs'][number]['gas_oracle'],
                            keyof import('../post_dispatch/v1/types.js').GasOracle
                          >]: never;
                        })
                      | undefined;
                    gas_overhead?: string | undefined;
                    igp_id?: string | undefined;
                  } & {
                    [K_10 in Exclude<
                      keyof I['post_dispatch_genesis']['igp_gas_configs'][number],
                      keyof import('../post_dispatch/v1/genesis.js').GenesisDestinationGasConfigWrapper
                    >]: never;
                  })[] & {
                    [K_11 in Exclude<
                      keyof I['post_dispatch_genesis']['igp_gas_configs'],
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
                                  [K_12 in Exclude<
                                    keyof I['post_dispatch_genesis']['merkle_tree_hooks'][number]['tree']['branch'],
                                    keyof Uint8Array[]
                                  >]: never;
                                })
                            | undefined;
                          count?: number | undefined;
                        } & {
                          [K_13 in Exclude<
                            keyof I['post_dispatch_genesis']['merkle_tree_hooks'][number]['tree'],
                            keyof import('../post_dispatch/v1/types.js').Tree
                          >]: never;
                        })
                      | undefined;
                  } & {
                    [K_14 in Exclude<
                      keyof I['post_dispatch_genesis']['merkle_tree_hooks'][number],
                      keyof import('../post_dispatch/v1/types.js').MerkleTreeHook
                    >]: never;
                  })[] & {
                    [K_15 in Exclude<
                      keyof I['post_dispatch_genesis']['merkle_tree_hooks'],
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
                    [K_16 in Exclude<
                      keyof I['post_dispatch_genesis']['noop_hooks'][number],
                      keyof import('../post_dispatch/v1/types.js').NoopHook
                    >]: never;
                  })[] & {
                    [K_17 in Exclude<
                      keyof I['post_dispatch_genesis']['noop_hooks'],
                      keyof {
                        id?: string | undefined;
                        owner?: string | undefined;
                      }[]
                    >]: never;
                  })
              | undefined;
          } & {
            [K_18 in Exclude<
              keyof I['post_dispatch_genesis'],
              keyof GenesisState2
            >]: never;
          })
        | undefined;
      mailboxes?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              message_sent?: number | undefined;
              message_received?: number | undefined;
              default_ism?: string | undefined;
              default_hook?: string | undefined;
              required_hook?: string | undefined;
              local_domain?: number | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              message_sent?: number | undefined;
              message_received?: number | undefined;
              default_ism?: string | undefined;
              default_hook?: string | undefined;
              required_hook?: string | undefined;
              local_domain?: number | undefined;
            } & {
              [K_19 in Exclude<
                keyof I['mailboxes'][number],
                keyof Mailbox
              >]: never;
            })[] & {
              [K_20 in Exclude<
                keyof I['mailboxes'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  message_sent?: number | undefined;
                  message_received?: number | undefined;
                  default_ism?: string | undefined;
                  default_hook?: string | undefined;
                  required_hook?: string | undefined;
                  local_domain?: number | undefined;
                }[]
              >]: never;
            })
        | undefined;
      messages?:
        | ({
            mailbox_id?: string | undefined;
            message_id?: string | undefined;
          }[] &
            ({
              mailbox_id?: string | undefined;
              message_id?: string | undefined;
            } & {
              mailbox_id?: string | undefined;
              message_id?: string | undefined;
            } & {
              [K_21 in Exclude<
                keyof I['messages'][number],
                keyof GenesisMailboxMessageWrapper
              >]: never;
            })[] & {
              [K_22 in Exclude<
                keyof I['messages'],
                keyof {
                  mailbox_id?: string | undefined;
                  message_id?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      ism_sequence?: string | undefined;
      post_dispatch_sequence?: string | undefined;
      app_sequence?: string | undefined;
    } & { [K_23 in Exclude<keyof I, keyof GenesisState>]: never },
  >(
    base?: I | undefined,
  ): GenesisState;
  fromPartial<
    I_1 extends {
      ism_genesis?:
        | {
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
          }
        | undefined;
      post_dispatch_genesis?:
        | {
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
          }
        | undefined;
      mailboxes?:
        | {
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }[]
        | undefined;
      messages?:
        | {
            mailbox_id?: string | undefined;
            message_id?: string | undefined;
          }[]
        | undefined;
      ism_sequence?: string | undefined;
      post_dispatch_sequence?: string | undefined;
      app_sequence?: string | undefined;
    } & {
      ism_genesis?:
        | ({
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
                    [K_24 in Exclude<
                      keyof I_1['ism_genesis']['isms'][number],
                      keyof import('../../../google/protobuf/any.js').Any
                    >]: never;
                  })[] & {
                    [K_25 in Exclude<
                      keyof I_1['ism_genesis']['isms'],
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
                    [K_26 in Exclude<
                      keyof I_1['ism_genesis']['validator_storage_locations'][number],
                      keyof import('../interchain_security/v1/genesis.js').GenesisValidatorStorageLocationWrapper
                    >]: never;
                  })[] & {
                    [K_27 in Exclude<
                      keyof I_1['ism_genesis']['validator_storage_locations'],
                      keyof {
                        mailbox_id?: string | undefined;
                        validator_address?: string | undefined;
                        index?: string | undefined;
                        storage_location?: string | undefined;
                      }[]
                    >]: never;
                  })
              | undefined;
          } & {
            [K_28 in Exclude<
              keyof I_1['ism_genesis'],
              keyof GenesisState1
            >]: never;
          })
        | undefined;
      post_dispatch_genesis?:
        | ({
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
                            [K_29 in Exclude<
                              keyof I_1['post_dispatch_genesis']['igps'][number]['claimable_fees'][number],
                              keyof import('../../../cosmos/base/v1beta1/coin.js').Coin
                            >]: never;
                          })[] & {
                            [K_30 in Exclude<
                              keyof I_1['post_dispatch_genesis']['igps'][number]['claimable_fees'],
                              keyof {
                                denom?: string | undefined;
                                amount?: string | undefined;
                              }[]
                            >]: never;
                          })
                      | undefined;
                  } & {
                    [K_31 in Exclude<
                      keyof I_1['post_dispatch_genesis']['igps'][number],
                      keyof import('../post_dispatch/v1/types.js').InterchainGasPaymaster
                    >]: never;
                  })[] & {
                    [K_32 in Exclude<
                      keyof I_1['post_dispatch_genesis']['igps'],
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
                          [K_33 in Exclude<
                            keyof I_1['post_dispatch_genesis']['igp_gas_configs'][number]['gas_oracle'],
                            keyof import('../post_dispatch/v1/types.js').GasOracle
                          >]: never;
                        })
                      | undefined;
                    gas_overhead?: string | undefined;
                    igp_id?: string | undefined;
                  } & {
                    [K_34 in Exclude<
                      keyof I_1['post_dispatch_genesis']['igp_gas_configs'][number],
                      keyof import('../post_dispatch/v1/genesis.js').GenesisDestinationGasConfigWrapper
                    >]: never;
                  })[] & {
                    [K_35 in Exclude<
                      keyof I_1['post_dispatch_genesis']['igp_gas_configs'],
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
                                  [K_36 in Exclude<
                                    keyof I_1['post_dispatch_genesis']['merkle_tree_hooks'][number]['tree']['branch'],
                                    keyof Uint8Array[]
                                  >]: never;
                                })
                            | undefined;
                          count?: number | undefined;
                        } & {
                          [K_37 in Exclude<
                            keyof I_1['post_dispatch_genesis']['merkle_tree_hooks'][number]['tree'],
                            keyof import('../post_dispatch/v1/types.js').Tree
                          >]: never;
                        })
                      | undefined;
                  } & {
                    [K_38 in Exclude<
                      keyof I_1['post_dispatch_genesis']['merkle_tree_hooks'][number],
                      keyof import('../post_dispatch/v1/types.js').MerkleTreeHook
                    >]: never;
                  })[] & {
                    [K_39 in Exclude<
                      keyof I_1['post_dispatch_genesis']['merkle_tree_hooks'],
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
                    [K_40 in Exclude<
                      keyof I_1['post_dispatch_genesis']['noop_hooks'][number],
                      keyof import('../post_dispatch/v1/types.js').NoopHook
                    >]: never;
                  })[] & {
                    [K_41 in Exclude<
                      keyof I_1['post_dispatch_genesis']['noop_hooks'],
                      keyof {
                        id?: string | undefined;
                        owner?: string | undefined;
                      }[]
                    >]: never;
                  })
              | undefined;
          } & {
            [K_42 in Exclude<
              keyof I_1['post_dispatch_genesis'],
              keyof GenesisState2
            >]: never;
          })
        | undefined;
      mailboxes?:
        | ({
            id?: string | undefined;
            owner?: string | undefined;
            message_sent?: number | undefined;
            message_received?: number | undefined;
            default_ism?: string | undefined;
            default_hook?: string | undefined;
            required_hook?: string | undefined;
            local_domain?: number | undefined;
          }[] &
            ({
              id?: string | undefined;
              owner?: string | undefined;
              message_sent?: number | undefined;
              message_received?: number | undefined;
              default_ism?: string | undefined;
              default_hook?: string | undefined;
              required_hook?: string | undefined;
              local_domain?: number | undefined;
            } & {
              id?: string | undefined;
              owner?: string | undefined;
              message_sent?: number | undefined;
              message_received?: number | undefined;
              default_ism?: string | undefined;
              default_hook?: string | undefined;
              required_hook?: string | undefined;
              local_domain?: number | undefined;
            } & {
              [K_43 in Exclude<
                keyof I_1['mailboxes'][number],
                keyof Mailbox
              >]: never;
            })[] & {
              [K_44 in Exclude<
                keyof I_1['mailboxes'],
                keyof {
                  id?: string | undefined;
                  owner?: string | undefined;
                  message_sent?: number | undefined;
                  message_received?: number | undefined;
                  default_ism?: string | undefined;
                  default_hook?: string | undefined;
                  required_hook?: string | undefined;
                  local_domain?: number | undefined;
                }[]
              >]: never;
            })
        | undefined;
      messages?:
        | ({
            mailbox_id?: string | undefined;
            message_id?: string | undefined;
          }[] &
            ({
              mailbox_id?: string | undefined;
              message_id?: string | undefined;
            } & {
              mailbox_id?: string | undefined;
              message_id?: string | undefined;
            } & {
              [K_45 in Exclude<
                keyof I_1['messages'][number],
                keyof GenesisMailboxMessageWrapper
              >]: never;
            })[] & {
              [K_46 in Exclude<
                keyof I_1['messages'],
                keyof {
                  mailbox_id?: string | undefined;
                  message_id?: string | undefined;
                }[]
              >]: never;
            })
        | undefined;
      ism_sequence?: string | undefined;
      post_dispatch_sequence?: string | undefined;
      app_sequence?: string | undefined;
    } & { [K_47 in Exclude<keyof I_1, keyof GenesisState>]: never },
  >(
    object: I_1,
  ): GenesisState;
};
export declare const GenesisMailboxMessageWrapper: {
  encode(
    message: GenesisMailboxMessageWrapper,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): GenesisMailboxMessageWrapper;
  fromJSON(object: any): GenesisMailboxMessageWrapper;
  toJSON(message: GenesisMailboxMessageWrapper): unknown;
  create<
    I extends {
      mailbox_id?: string | undefined;
      message_id?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      message_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof GenesisMailboxMessageWrapper>]: never },
  >(
    base?: I | undefined,
  ): GenesisMailboxMessageWrapper;
  fromPartial<
    I_1 extends {
      mailbox_id?: string | undefined;
      message_id?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      message_id?: string | undefined;
    } & {
      [K_1 in Exclude<keyof I_1, keyof GenesisMailboxMessageWrapper>]: never;
    },
  >(
    object: I_1,
  ): GenesisMailboxMessageWrapper;
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
