import _m0 from 'protobufjs/minimal.js';

import { Coin } from '../../../../cosmos/base/v1beta1/coin.js';

import { DestinationGasConfig } from './types.js';

export declare const protobufPackage = 'hyperlane.core.post_dispatch.v1';
/** MsgCreateIgp ... */
export interface MsgCreateIgp {
  /** owner is the message sender. */
  owner: string;
  /** denom */
  denom: string;
}
/** MsgCreateIgpResponse ... */
export interface MsgCreateIgpResponse {
  id: string;
}
/** MsgSetIgpOwner ... */
export interface MsgSetIgpOwner {
  /** owner is the message sender. */
  owner: string;
  /** igp_id */
  igp_id: string;
  /** new_owner */
  new_owner: string;
}
/** MsgCreateIgpResponse ... */
export interface MsgSetIgpOwnerResponse {}
/** MsgSetDestinationGasConfig ... */
export interface MsgSetDestinationGasConfig {
  /** owner ... */
  owner: string;
  /** igp_id ... */
  igp_id: string;
  /** destination_gas_config ... */
  destination_gas_config?: DestinationGasConfig | undefined;
}
/** MsgSetDestinationGasConfigResponse ... */
export interface MsgSetDestinationGasConfigResponse {}
/** MsgPayForGas ... */
export interface MsgPayForGas {
  /** sender ... */
  sender: string;
  /** igp_id ... */
  igp_id: string;
  /** message_id ... */
  message_id: string;
  /** destination_domain ... */
  destination_domain: number;
  /** gas_limit ... */
  gas_limit: string;
  /** amount ... */
  amount?: Coin | undefined;
}
/** MsgPayForGasResponse ... */
export interface MsgPayForGasResponse {}
/** MsgClaim ... */
export interface MsgClaim {
  /** sender ... */
  sender: string;
  /** igp_id ... */
  igp_id: string;
}
/** MsgClaimResponse ... */
export interface MsgClaimResponse {}
/** MsgMerkleTreeHook ... */
export interface MsgCreateMerkleTreeHook {
  /** sender ... */
  owner: string;
  mailbox_id: string;
}
/** MsgCreateMerkleTreeHookResponse ... */
export interface MsgCreateMerkleTreeHookResponse {
  id: string;
}
/** MsgMerkleTreeHook ... */
export interface MsgCreateNoopHook {
  /** sender ... */
  owner: string;
}
/** MsgCreateMerkleTreeHookResponse ... */
export interface MsgCreateNoopHookResponse {
  id: string;
}
export declare const MsgCreateIgp: {
  encode(message: MsgCreateIgp, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateIgp;
  fromJSON(object: any): MsgCreateIgp;
  toJSON(message: MsgCreateIgp): unknown;
  create<
    I extends {
      owner?: string | undefined;
      denom?: string | undefined;
    } & {
      owner?: string | undefined;
      denom?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgCreateIgp>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateIgp;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      denom?: string | undefined;
    } & {
      owner?: string | undefined;
      denom?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgCreateIgp>]: never },
  >(
    object: I_1,
  ): MsgCreateIgp;
};
export declare const MsgCreateIgpResponse: {
  encode(message: MsgCreateIgpResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateIgpResponse;
  fromJSON(object: any): MsgCreateIgpResponse;
  toJSON(message: MsgCreateIgpResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateIgpResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateIgpResponse;
};
export declare const MsgSetIgpOwner: {
  encode(message: MsgSetIgpOwner, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgSetIgpOwner;
  fromJSON(object: any): MsgSetIgpOwner;
  toJSON(message: MsgSetIgpOwner): unknown;
  create<
    I extends {
      owner?: string | undefined;
      igp_id?: string | undefined;
      new_owner?: string | undefined;
    } & {
      owner?: string | undefined;
      igp_id?: string | undefined;
      new_owner?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgSetIgpOwner>]: never },
  >(
    base?: I | undefined,
  ): MsgSetIgpOwner;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      igp_id?: string | undefined;
      new_owner?: string | undefined;
    } & {
      owner?: string | undefined;
      igp_id?: string | undefined;
      new_owner?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgSetIgpOwner>]: never },
  >(
    object: I_1,
  ): MsgSetIgpOwner;
};
export declare const MsgSetIgpOwnerResponse: {
  encode(_: MsgSetIgpOwnerResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgSetIgpOwnerResponse;
  fromJSON(_: any): MsgSetIgpOwnerResponse;
  toJSON(_: MsgSetIgpOwnerResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgSetIgpOwnerResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgSetIgpOwnerResponse;
};
export declare const MsgSetDestinationGasConfig: {
  encode(message: MsgSetDestinationGasConfig, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgSetDestinationGasConfig;
  fromJSON(object: any): MsgSetDestinationGasConfig;
  toJSON(message: MsgSetDestinationGasConfig): unknown;
  create<
    I extends {
      owner?: string | undefined;
      igp_id?: string | undefined;
      destination_gas_config?:
        | {
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
          }
        | undefined;
    } & {
      owner?: string | undefined;
      igp_id?: string | undefined;
      destination_gas_config?:
        | ({
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
                    keyof I['destination_gas_config']['gas_oracle'],
                    keyof import('./types.js').GasOracle
                  >]: never;
                })
              | undefined;
            gas_overhead?: string | undefined;
          } & {
            [K_1 in Exclude<
              keyof I['destination_gas_config'],
              keyof DestinationGasConfig
            >]: never;
          })
        | undefined;
    } & { [K_2 in Exclude<keyof I, keyof MsgSetDestinationGasConfig>]: never },
  >(
    base?: I | undefined,
  ): MsgSetDestinationGasConfig;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      igp_id?: string | undefined;
      destination_gas_config?:
        | {
            remote_domain?: number | undefined;
            gas_oracle?:
              | {
                  token_exchange_rate?: string | undefined;
                  gas_price?: string | undefined;
                }
              | undefined;
            gas_overhead?: string | undefined;
          }
        | undefined;
    } & {
      owner?: string | undefined;
      igp_id?: string | undefined;
      destination_gas_config?:
        | ({
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
                  [K_3 in Exclude<
                    keyof I_1['destination_gas_config']['gas_oracle'],
                    keyof import('./types.js').GasOracle
                  >]: never;
                })
              | undefined;
            gas_overhead?: string | undefined;
          } & {
            [K_4 in Exclude<
              keyof I_1['destination_gas_config'],
              keyof DestinationGasConfig
            >]: never;
          })
        | undefined;
    } & {
      [K_5 in Exclude<keyof I_1, keyof MsgSetDestinationGasConfig>]: never;
    },
  >(
    object: I_1,
  ): MsgSetDestinationGasConfig;
};
export declare const MsgSetDestinationGasConfigResponse: {
  encode(
    _: MsgSetDestinationGasConfigResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgSetDestinationGasConfigResponse;
  fromJSON(_: any): MsgSetDestinationGasConfigResponse;
  toJSON(_: MsgSetDestinationGasConfigResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgSetDestinationGasConfigResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgSetDestinationGasConfigResponse;
};
export declare const MsgPayForGas: {
  encode(message: MsgPayForGas, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgPayForGas;
  fromJSON(object: any): MsgPayForGas;
  toJSON(message: MsgPayForGas): unknown;
  create<
    I extends {
      sender?: string | undefined;
      igp_id?: string | undefined;
      message_id?: string | undefined;
      destination_domain?: number | undefined;
      gas_limit?: string | undefined;
      amount?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }
        | undefined;
    } & {
      sender?: string | undefined;
      igp_id?: string | undefined;
      message_id?: string | undefined;
      destination_domain?: number | undefined;
      gas_limit?: string | undefined;
      amount?:
        | ({
            denom?: string | undefined;
            amount?: string | undefined;
          } & {
            denom?: string | undefined;
            amount?: string | undefined;
          } & { [K in Exclude<keyof I['amount'], keyof Coin>]: never })
        | undefined;
    } & { [K_1 in Exclude<keyof I, keyof MsgPayForGas>]: never },
  >(
    base?: I | undefined,
  ): MsgPayForGas;
  fromPartial<
    I_1 extends {
      sender?: string | undefined;
      igp_id?: string | undefined;
      message_id?: string | undefined;
      destination_domain?: number | undefined;
      gas_limit?: string | undefined;
      amount?:
        | {
            denom?: string | undefined;
            amount?: string | undefined;
          }
        | undefined;
    } & {
      sender?: string | undefined;
      igp_id?: string | undefined;
      message_id?: string | undefined;
      destination_domain?: number | undefined;
      gas_limit?: string | undefined;
      amount?:
        | ({
            denom?: string | undefined;
            amount?: string | undefined;
          } & {
            denom?: string | undefined;
            amount?: string | undefined;
          } & { [K_2 in Exclude<keyof I_1['amount'], keyof Coin>]: never })
        | undefined;
    } & { [K_3 in Exclude<keyof I_1, keyof MsgPayForGas>]: never },
  >(
    object: I_1,
  ): MsgPayForGas;
};
export declare const MsgPayForGasResponse: {
  encode(_: MsgPayForGasResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgPayForGasResponse;
  fromJSON(_: any): MsgPayForGasResponse;
  toJSON(_: MsgPayForGasResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgPayForGasResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgPayForGasResponse;
};
export declare const MsgClaim: {
  encode(message: MsgClaim, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgClaim;
  fromJSON(object: any): MsgClaim;
  toJSON(message: MsgClaim): unknown;
  create<
    I extends {
      sender?: string | undefined;
      igp_id?: string | undefined;
    } & {
      sender?: string | undefined;
      igp_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgClaim>]: never },
  >(
    base?: I | undefined,
  ): MsgClaim;
  fromPartial<
    I_1 extends {
      sender?: string | undefined;
      igp_id?: string | undefined;
    } & {
      sender?: string | undefined;
      igp_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgClaim>]: never },
  >(
    object: I_1,
  ): MsgClaim;
};
export declare const MsgClaimResponse: {
  encode(_: MsgClaimResponse, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgClaimResponse;
  fromJSON(_: any): MsgClaimResponse;
  toJSON(_: MsgClaimResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgClaimResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgClaimResponse;
};
export declare const MsgCreateMerkleTreeHook: {
  encode(message: MsgCreateMerkleTreeHook, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMerkleTreeHook;
  fromJSON(object: any): MsgCreateMerkleTreeHook;
  toJSON(message: MsgCreateMerkleTreeHook): unknown;
  create<
    I extends {
      owner?: string | undefined;
      mailbox_id?: string | undefined;
    } & {
      owner?: string | undefined;
      mailbox_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgCreateMerkleTreeHook>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateMerkleTreeHook;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      mailbox_id?: string | undefined;
    } & {
      owner?: string | undefined;
      mailbox_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgCreateMerkleTreeHook>]: never },
  >(
    object: I_1,
  ): MsgCreateMerkleTreeHook;
};
export declare const MsgCreateMerkleTreeHookResponse: {
  encode(
    message: MsgCreateMerkleTreeHookResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMerkleTreeHookResponse;
  fromJSON(object: any): MsgCreateMerkleTreeHookResponse;
  toJSON(message: MsgCreateMerkleTreeHookResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateMerkleTreeHookResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateMerkleTreeHookResponse;
};
export declare const MsgCreateNoopHook: {
  encode(message: MsgCreateNoopHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateNoopHook;
  fromJSON(object: any): MsgCreateNoopHook;
  toJSON(message: MsgCreateNoopHook): unknown;
  create<
    I extends {
      owner?: string | undefined;
    } & {
      owner?: string | undefined;
    } & { [K in Exclude<keyof I, 'owner'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateNoopHook;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
    } & {
      owner?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'owner'>]: never },
  >(
    object: I_1,
  ): MsgCreateNoopHook;
};
export declare const MsgCreateNoopHookResponse: {
  encode(message: MsgCreateNoopHookResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateNoopHookResponse;
  fromJSON(object: any): MsgCreateNoopHookResponse;
  toJSON(message: MsgCreateNoopHookResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateNoopHookResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateNoopHookResponse;
};
/** Msg defines the module Msg service. */
export interface Msg {
  /** CreateIgp ... */
  CreateIgp(request: MsgCreateIgp): Promise<MsgCreateIgpResponse>;
  /** SetIgpOwner ... */
  SetIgpOwner(request: MsgSetIgpOwner): Promise<MsgSetIgpOwnerResponse>;
  /** SetDestinationGasConfig ... */
  SetDestinationGasConfig(
    request: MsgSetDestinationGasConfig,
  ): Promise<MsgSetDestinationGasConfigResponse>;
  /** PayForGas ... */
  PayForGas(request: MsgPayForGas): Promise<MsgPayForGasResponse>;
  /** Claim ... */
  Claim(request: MsgClaim): Promise<MsgClaimResponse>;
  /** CreateMerkleTreeHook ... */
  CreateMerkleTreeHook(
    request: MsgCreateMerkleTreeHook,
  ): Promise<MsgCreateMerkleTreeHookResponse>;
  /** CreateNoopHook ... */
  CreateNoopHook(
    request: MsgCreateNoopHook,
  ): Promise<MsgCreateNoopHookResponse>;
}
export declare const MsgServiceName = 'hyperlane.core.post_dispatch.v1.Msg';
export declare class MsgClientImpl implements Msg {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  CreateIgp(request: MsgCreateIgp): Promise<MsgCreateIgpResponse>;
  SetIgpOwner(request: MsgSetIgpOwner): Promise<MsgSetIgpOwnerResponse>;
  SetDestinationGasConfig(
    request: MsgSetDestinationGasConfig,
  ): Promise<MsgSetDestinationGasConfigResponse>;
  PayForGas(request: MsgPayForGas): Promise<MsgPayForGasResponse>;
  Claim(request: MsgClaim): Promise<MsgClaimResponse>;
  CreateMerkleTreeHook(
    request: MsgCreateMerkleTreeHook,
  ): Promise<MsgCreateMerkleTreeHookResponse>;
  CreateNoopHook(
    request: MsgCreateNoopHook,
  ): Promise<MsgCreateNoopHookResponse>;
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
//# sourceMappingURL=tx.d.ts.map
