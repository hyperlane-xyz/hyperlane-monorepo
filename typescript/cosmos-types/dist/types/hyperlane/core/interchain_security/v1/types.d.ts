import _m0 from 'protobufjs/minimal.js';

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
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
      validators?: string[] | undefined;
      threshold?: number | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      validators?:
        | (string[] &
            string[] & {
              [K in Exclude<keyof I['validators'], keyof string[]>]: never;
            })
        | undefined;
      threshold?: number | undefined;
    } & { [K_1 in Exclude<keyof I, keyof MessageIdMultisigISM>]: never },
  >(
    base?: I | undefined,
  ): MessageIdMultisigISM;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
      validators?: string[] | undefined;
      threshold?: number | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      validators?:
        | (string[] &
            string[] & {
              [K_2 in Exclude<keyof I_1['validators'], keyof string[]>]: never;
            })
        | undefined;
      threshold?: number | undefined;
    } & { [K_3 in Exclude<keyof I_1, keyof MessageIdMultisigISM>]: never },
  >(
    object: I_1,
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
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
      validators?: string[] | undefined;
      threshold?: number | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      validators?:
        | (string[] &
            string[] & {
              [K in Exclude<keyof I['validators'], keyof string[]>]: never;
            })
        | undefined;
      threshold?: number | undefined;
    } & { [K_1 in Exclude<keyof I, keyof MerkleRootMultisigISM>]: never },
  >(
    base?: I | undefined,
  ): MerkleRootMultisigISM;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
      validators?: string[] | undefined;
      threshold?: number | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
      validators?:
        | (string[] &
            string[] & {
              [K_2 in Exclude<keyof I_1['validators'], keyof string[]>]: never;
            })
        | undefined;
      threshold?: number | undefined;
    } & { [K_3 in Exclude<keyof I_1, keyof MerkleRootMultisigISM>]: never },
  >(
    object: I_1,
  ): MerkleRootMultisigISM;
};
export declare const NoopISM: {
  encode(message: NoopISM, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): NoopISM;
  fromJSON(object: any): NoopISM;
  toJSON(message: NoopISM): unknown;
  create<
    I extends {
      id?: string | undefined;
      owner?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
    } & { [K in Exclude<keyof I, keyof NoopISM>]: never },
  >(
    base?: I | undefined,
  ): NoopISM;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
      owner?: string | undefined;
    } & {
      id?: string | undefined;
      owner?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof NoopISM>]: never },
  >(
    object: I_1,
  ): NoopISM;
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
