import _m0 from 'protobufjs/minimal';

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
  /** mailbox_id ... */
  mailbox_id: string;
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
  create<I extends Exact<DeepPartial<EventCreateMerkleTreeHook>, I>>(
    base?: I,
  ): EventCreateMerkleTreeHook;
  fromPartial<I extends Exact<DeepPartial<EventCreateMerkleTreeHook>, I>>(
    object: I,
  ): EventCreateMerkleTreeHook;
};
export declare const InsertedIntoTree: {
  encode(message: InsertedIntoTree, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): InsertedIntoTree;
  fromJSON(object: any): InsertedIntoTree;
  toJSON(message: InsertedIntoTree): unknown;
  create<I extends Exact<DeepPartial<InsertedIntoTree>, I>>(
    base?: I,
  ): InsertedIntoTree;
  fromPartial<I extends Exact<DeepPartial<InsertedIntoTree>, I>>(
    object: I,
  ): InsertedIntoTree;
};
export declare const GasPayment: {
  encode(message: GasPayment, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): GasPayment;
  fromJSON(object: any): GasPayment;
  toJSON(message: GasPayment): unknown;
  create<I extends Exact<DeepPartial<GasPayment>, I>>(base?: I): GasPayment;
  fromPartial<I extends Exact<DeepPartial<GasPayment>, I>>(
    object: I,
  ): GasPayment;
};
export declare const EventCreateNoopHook: {
  encode(message: EventCreateNoopHook, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): EventCreateNoopHook;
  fromJSON(object: any): EventCreateNoopHook;
  toJSON(message: EventCreateNoopHook): unknown;
  create<I extends Exact<DeepPartial<EventCreateNoopHook>, I>>(
    base?: I,
  ): EventCreateNoopHook;
  fromPartial<I extends Exact<DeepPartial<EventCreateNoopHook>, I>>(
    object: I,
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
