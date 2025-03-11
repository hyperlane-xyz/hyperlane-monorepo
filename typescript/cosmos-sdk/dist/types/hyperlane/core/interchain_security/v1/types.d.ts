import _m0 from 'protobufjs/minimal';

export declare const protobufPackage = 'hyperlane.core.interchain_security.v1';
/** MessageIdMultisigISM ... */
export interface MessageIdMultisigISM {
  /** id ... */
  id: string;
  /** owner ... */
  owner: string;
  /**
   * validators
   * these are 20 byte long ethereum style addresses
   */
  validators: string[];
  /** threshold ... */
  threshold: number;
}
/** MerkleRootMultisigISM ... */
export interface MerkleRootMultisigISM {
  /** XXX ... */
  id: string;
  /** owner ... */
  owner: string;
  /**
   * validators
   * these are 20 byte long ethereum style addresses
   */
  validators: string[];
  /** threshold ... */
  threshold: number;
}
/** NoopISM ... */
export interface NoopISM {
  /** id ... */
  id: string;
  /** owner ... */
  owner: string;
}
export declare const MessageIdMultisigISM: {
  encode(message: MessageIdMultisigISM, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MessageIdMultisigISM;
  fromJSON(object: any): MessageIdMultisigISM;
  toJSON(message: MessageIdMultisigISM): unknown;
  create<I extends Exact<DeepPartial<MessageIdMultisigISM>, I>>(
    base?: I,
  ): MessageIdMultisigISM;
  fromPartial<I extends Exact<DeepPartial<MessageIdMultisigISM>, I>>(
    object: I,
  ): MessageIdMultisigISM;
};
export declare const MerkleRootMultisigISM: {
  encode(message: MerkleRootMultisigISM, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MerkleRootMultisigISM;
  fromJSON(object: any): MerkleRootMultisigISM;
  toJSON(message: MerkleRootMultisigISM): unknown;
  create<I extends Exact<DeepPartial<MerkleRootMultisigISM>, I>>(
    base?: I,
  ): MerkleRootMultisigISM;
  fromPartial<I extends Exact<DeepPartial<MerkleRootMultisigISM>, I>>(
    object: I,
  ): MerkleRootMultisigISM;
};
export declare const NoopISM: {
  encode(message: NoopISM, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): NoopISM;
  fromJSON(object: any): NoopISM;
  toJSON(message: NoopISM): unknown;
  create<I extends Exact<DeepPartial<NoopISM>, I>>(base?: I): NoopISM;
  fromPartial<I extends Exact<DeepPartial<NoopISM>, I>>(object: I): NoopISM;
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
