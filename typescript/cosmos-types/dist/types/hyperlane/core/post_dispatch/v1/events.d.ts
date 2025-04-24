import _m0 from 'protobufjs/minimal.js';

export declare const protobufPackage = 'hyperlane.core.post_dispatch.v1';
/** InsertedIntoTree ... */
export interface EventCreateMerkleTreeHook {
  /** id ... */
  id: string;
  /** mailbox_id ... */
  mailbox_id: string;
  owner: string;
}
/** InsertedIntoTree ... */
export interface InsertedIntoTree {
  /** message_id ... */
  message_id: string;
  /** index ... */
  index: number;
  /** merkle_tree_hook_id ... */
  merkle_tree_hook_id: string;
}
/** GasPayment ... */
export interface GasPayment {
  /** message_id ... */
  message_id: string;
  /** destination ... */
  destination: number;
  /** gas_amount ... */
  gas_amount: string;
  /** payment ... */
  payment: string;
  /** igp_id ... */
  igp_id: string;
}
/** InsertedIntoTree ... */
export interface EventCreateNoopHook {
  /** id ... */
  id: string;
  /** owner ... */
  owner: string;
}
export declare const EventCreateMerkleTreeHook: {
  encode(message: EventCreateMerkleTreeHook, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): EventCreateMerkleTreeHook;
  fromJSON(object: any): EventCreateMerkleTreeHook;
  toJSON(message: EventCreateMerkleTreeHook): unknown;
  create<
    I extends {
      id?: string | undefined;
      mailbox_id?: string | undefined;
      owner?: string | undefined;
    } & {
      id?: string | undefined;
      mailbox_id?: string | undefined;
      owner?: string | undefined;
    } & { [K in Exclude<keyof I, keyof EventCreateMerkleTreeHook>]: never },
  >(
    base?: I | undefined,
  ): EventCreateMerkleTreeHook;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      mailbox_id?: string | undefined;
      owner?: string | undefined;
    } & {
      id?: string | undefined;
      mailbox_id?: string | undefined;
      owner?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof EventCreateMerkleTreeHook>]: never },
  >(
    object: I_1,
  ): EventCreateMerkleTreeHook;
};
export declare const InsertedIntoTree: {
  encode(message: InsertedIntoTree, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): InsertedIntoTree;
  fromJSON(object: any): InsertedIntoTree;
  toJSON(message: InsertedIntoTree): unknown;
  create<
    I extends {
      message_id?: string | undefined;
      index?: number | undefined;
      merkle_tree_hook_id?: string | undefined;
    } & {
      message_id?: string | undefined;
      index?: number | undefined;
      merkle_tree_hook_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof InsertedIntoTree>]: never },
  >(
    base?: I | undefined,
  ): InsertedIntoTree;
  fromPartial<
    I_1 extends {
      message_id?: string | undefined;
      index?: number | undefined;
      merkle_tree_hook_id?: string | undefined;
    } & {
      message_id?: string | undefined;
      index?: number | undefined;
      merkle_tree_hook_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof InsertedIntoTree>]: never },
  >(
    object: I_1,
  ): InsertedIntoTree;
};
export declare const GasPayment: {
  encode(message: GasPayment, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): GasPayment;
  fromJSON(object: any): GasPayment;
  toJSON(message: GasPayment): unknown;
  create<
    I extends {
      message_id?: string | undefined;
      destination?: number | undefined;
      gas_amount?: string | undefined;
      payment?: string | undefined;
      igp_id?: string | undefined;
    } & {
      message_id?: string | undefined;
      destination?: number | undefined;
      gas_amount?: string | undefined;
      payment?: string | undefined;
      igp_id?: string | undefined;
    } & { [K in Exclude<keyof I, keyof GasPayment>]: never },
  >(
    base?: I | undefined,
  ): GasPayment;
  fromPartial<
    I_1 extends {
      message_id?: string | undefined;
      destination?: number | undefined;
      gas_amount?: string | undefined;
      payment?: string | undefined;
      igp_id?: string | undefined;
    } & {
      message_id?: string | undefined;
      destination?: number | undefined;
      gas_amount?: string | undefined;
      payment?: string | undefined;
      igp_id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof GasPayment>]: never },
  >(
    object: I_1,
  ): GasPayment;
};
export declare const EventCreateNoopHook: {
  encode(message: EventCreateNoopHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): EventCreateNoopHook;
  fromJSON(object: any): EventCreateNoopHook;
  toJSON(message: EventCreateNoopHook): unknown;
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
    } & { [K in Exclude<keyof I, keyof EventCreateNoopHook>]: never },
  >(
    base?: I | undefined,
  ): EventCreateNoopHook;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof EventCreateNoopHook>]: never },
  >(
    object: I_1,
  ): EventCreateNoopHook;
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
//# sourceMappingURL=events.d.ts.map
