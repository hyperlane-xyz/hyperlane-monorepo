import _m0 from 'protobufjs/minimal.js';

export declare const protobufPackage = 'hyperlane.core.interchain_security.v1';
/** MsgCreateMessageIdMultisigIsm ... */
export interface MsgCreateMessageIdMultisigIsm {
  /** creator is the message sender. */
  creator: string;
  /**
   * validators
   * these are 20 byte long ethereum style addresses
   */
  validators: string[];
  /** threshold ... */
  threshold: number;
}
/** MsgCreateMessageIdMultisigIsmResponse ... */
export interface MsgCreateMessageIdMultisigIsmResponse {
  id: string;
}
/** MsgCreateMultisigIsm ... */
export interface MsgCreateMerkleRootMultisigIsm {
  /** creator is the message sender. */
  creator: string;
  /**
   * validators
   * these are 20 byte long ethereum style addresses
   */
  validators: string[];
  /** threshold ... */
  threshold: number;
}
/** MsgCreateMultisigIsmResponse ... */
export interface MsgCreateMerkleRootMultisigIsmResponse {
  id: string;
}
/** MsgCreateNoopIsm ... */
export interface MsgCreateNoopIsm {
  /** creator is the message sender. */
  creator: string;
}
/** MsgCreateNoopIsmResponse ... */
export interface MsgCreateNoopIsmResponse {
  id: string;
}
/** MsgAnnounceValidator ... */
export interface MsgAnnounceValidator {
  /** validator ... */
  validator: string;
  /** storage_location ... */
  storage_location: string;
  /** signature ... */
  signature: string;
  /** mailbox_id ... */
  mailbox_id: string;
  /** creator ... */
  creator: string;
}
/** MsgAnnounceValidatorResponse ... */
export interface MsgAnnounceValidatorResponse {}
export declare const MsgCreateMessageIdMultisigIsm: {
  encode(
    message: MsgCreateMessageIdMultisigIsm,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMessageIdMultisigIsm;
  fromJSON(object: any): MsgCreateMessageIdMultisigIsm;
  toJSON(message: MsgCreateMessageIdMultisigIsm): unknown;
  create<
    I extends {
      creator?: string | undefined;
      validators?: string[] | undefined;
      threshold?: number | undefined;
    } & {
      creator?: string | undefined;
      validators?:
        | (string[] &
            string[] & {
              [K in Exclude<keyof I['validators'], keyof string[]>]: never;
            })
        | undefined;
      threshold?: number | undefined;
    } & {
      [K_1 in Exclude<keyof I, keyof MsgCreateMessageIdMultisigIsm>]: never;
    },
  >(
    base?: I | undefined,
  ): MsgCreateMessageIdMultisigIsm;
  fromPartial<
    I_1 extends {
      creator?: string | undefined;
      validators?: string[] | undefined;
      threshold?: number | undefined;
    } & {
      creator?: string | undefined;
      validators?:
        | (string[] &
            string[] & {
              [K_2 in Exclude<keyof I_1['validators'], keyof string[]>]: never;
            })
        | undefined;
      threshold?: number | undefined;
    } & {
      [K_3 in Exclude<keyof I_1, keyof MsgCreateMessageIdMultisigIsm>]: never;
    },
  >(
    object: I_1,
  ): MsgCreateMessageIdMultisigIsm;
};
export declare const MsgCreateMessageIdMultisigIsmResponse: {
  encode(
    message: MsgCreateMessageIdMultisigIsmResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMessageIdMultisigIsmResponse;
  fromJSON(object: any): MsgCreateMessageIdMultisigIsmResponse;
  toJSON(message: MsgCreateMessageIdMultisigIsmResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateMessageIdMultisigIsmResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateMessageIdMultisigIsmResponse;
};
export declare const MsgCreateMerkleRootMultisigIsm: {
  encode(
    message: MsgCreateMerkleRootMultisigIsm,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMerkleRootMultisigIsm;
  fromJSON(object: any): MsgCreateMerkleRootMultisigIsm;
  toJSON(message: MsgCreateMerkleRootMultisigIsm): unknown;
  create<
    I extends {
      creator?: string | undefined;
      validators?: string[] | undefined;
      threshold?: number | undefined;
    } & {
      creator?: string | undefined;
      validators?:
        | (string[] &
            string[] & {
              [K in Exclude<keyof I['validators'], keyof string[]>]: never;
            })
        | undefined;
      threshold?: number | undefined;
    } & {
      [K_1 in Exclude<keyof I, keyof MsgCreateMerkleRootMultisigIsm>]: never;
    },
  >(
    base?: I | undefined,
  ): MsgCreateMerkleRootMultisigIsm;
  fromPartial<
    I_1 extends {
      creator?: string | undefined;
      validators?: string[] | undefined;
      threshold?: number | undefined;
    } & {
      creator?: string | undefined;
      validators?:
        | (string[] &
            string[] & {
              [K_2 in Exclude<keyof I_1['validators'], keyof string[]>]: never;
            })
        | undefined;
      threshold?: number | undefined;
    } & {
      [K_3 in Exclude<keyof I_1, keyof MsgCreateMerkleRootMultisigIsm>]: never;
    },
  >(
    object: I_1,
  ): MsgCreateMerkleRootMultisigIsm;
};
export declare const MsgCreateMerkleRootMultisigIsmResponse: {
  encode(
    message: MsgCreateMerkleRootMultisigIsmResponse,
    writer?: _m0.Writer,
  ): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMerkleRootMultisigIsmResponse;
  fromJSON(object: any): MsgCreateMerkleRootMultisigIsmResponse;
  toJSON(message: MsgCreateMerkleRootMultisigIsmResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateMerkleRootMultisigIsmResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateMerkleRootMultisigIsmResponse;
};
export declare const MsgCreateNoopIsm: {
  encode(message: MsgCreateNoopIsm, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateNoopIsm;
  fromJSON(object: any): MsgCreateNoopIsm;
  toJSON(message: MsgCreateNoopIsm): unknown;
  create<
    I extends {
      creator?: string | undefined;
    } & {
      creator?: string | undefined;
    } & { [K in Exclude<keyof I, 'creator'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateNoopIsm;
  fromPartial<
    I_1 extends {
      creator?: string | undefined;
    } & {
      creator?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'creator'>]: never },
  >(
    object: I_1,
  ): MsgCreateNoopIsm;
};
export declare const MsgCreateNoopIsmResponse: {
  encode(message: MsgCreateNoopIsmResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateNoopIsmResponse;
  fromJSON(object: any): MsgCreateNoopIsmResponse;
  toJSON(message: MsgCreateNoopIsmResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateNoopIsmResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateNoopIsmResponse;
};
export declare const MsgAnnounceValidator: {
  encode(message: MsgAnnounceValidator, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgAnnounceValidator;
  fromJSON(object: any): MsgAnnounceValidator;
  toJSON(message: MsgAnnounceValidator): unknown;
  create<
    I extends {
      validator?: string | undefined;
      storage_location?: string | undefined;
      signature?: string | undefined;
      mailbox_id?: string | undefined;
      creator?: string | undefined;
    } & {
      validator?: string | undefined;
      storage_location?: string | undefined;
      signature?: string | undefined;
      mailbox_id?: string | undefined;
      creator?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgAnnounceValidator>]: never },
  >(
    base?: I | undefined,
  ): MsgAnnounceValidator;
  fromPartial<
    I_1 extends {
      validator?: string | undefined;
      storage_location?: string | undefined;
      signature?: string | undefined;
      mailbox_id?: string | undefined;
      creator?: string | undefined;
    } & {
      validator?: string | undefined;
      storage_location?: string | undefined;
      signature?: string | undefined;
      mailbox_id?: string | undefined;
      creator?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgAnnounceValidator>]: never },
  >(
    object: I_1,
  ): MsgAnnounceValidator;
};
export declare const MsgAnnounceValidatorResponse: {
  encode(_: MsgAnnounceValidatorResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgAnnounceValidatorResponse;
  fromJSON(_: any): MsgAnnounceValidatorResponse;
  toJSON(_: MsgAnnounceValidatorResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgAnnounceValidatorResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgAnnounceValidatorResponse;
};
/** Msg defines the module Msg service. */
export interface Msg {
  /** CreateMessageIdMultisigIsm ... */
  CreateMessageIdMultisigIsm(
    request: MsgCreateMessageIdMultisigIsm,
  ): Promise<MsgCreateMessageIdMultisigIsmResponse>;
  /** CreateMerkleRootMultisigIsm ... */
  CreateMerkleRootMultisigIsm(
    request: MsgCreateMerkleRootMultisigIsm,
  ): Promise<MsgCreateMerkleRootMultisigIsmResponse>;
  /** CreateNoopIsm ... */
  CreateNoopIsm(request: MsgCreateNoopIsm): Promise<MsgCreateNoopIsmResponse>;
  /** AnnounceValidator ... */
  AnnounceValidator(
    request: MsgAnnounceValidator,
  ): Promise<MsgAnnounceValidatorResponse>;
}
export declare const MsgServiceName =
  'hyperlane.core.interchain_security.v1.Msg';
export declare class MsgClientImpl implements Msg {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  CreateMessageIdMultisigIsm(
    request: MsgCreateMessageIdMultisigIsm,
  ): Promise<MsgCreateMessageIdMultisigIsmResponse>;
  CreateMerkleRootMultisigIsm(
    request: MsgCreateMerkleRootMultisigIsm,
  ): Promise<MsgCreateMerkleRootMultisigIsmResponse>;
  CreateNoopIsm(request: MsgCreateNoopIsm): Promise<MsgCreateNoopIsmResponse>;
  AnnounceValidator(
    request: MsgAnnounceValidator,
  ): Promise<MsgAnnounceValidatorResponse>;
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
