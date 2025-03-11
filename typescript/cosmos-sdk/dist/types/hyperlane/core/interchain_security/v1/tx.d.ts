import _m0 from 'protobufjs/minimal';

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
  create<I extends Exact<DeepPartial<MsgCreateMessageIdMultisigIsm>, I>>(
    base?: I,
  ): MsgCreateMessageIdMultisigIsm;
  fromPartial<I extends Exact<DeepPartial<MsgCreateMessageIdMultisigIsm>, I>>(
    object: I,
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
    I extends Exact<DeepPartial<MsgCreateMessageIdMultisigIsmResponse>, I>,
  >(
    base?: I,
  ): MsgCreateMessageIdMultisigIsmResponse;
  fromPartial<
    I extends Exact<DeepPartial<MsgCreateMessageIdMultisigIsmResponse>, I>,
  >(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgCreateMerkleRootMultisigIsm>, I>>(
    base?: I,
  ): MsgCreateMerkleRootMultisigIsm;
  fromPartial<I extends Exact<DeepPartial<MsgCreateMerkleRootMultisigIsm>, I>>(
    object: I,
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
    I extends Exact<DeepPartial<MsgCreateMerkleRootMultisigIsmResponse>, I>,
  >(
    base?: I,
  ): MsgCreateMerkleRootMultisigIsmResponse;
  fromPartial<
    I extends Exact<DeepPartial<MsgCreateMerkleRootMultisigIsmResponse>, I>,
  >(
    object: I,
  ): MsgCreateMerkleRootMultisigIsmResponse;
};
export declare const MsgCreateNoopIsm: {
  encode(message: MsgCreateNoopIsm, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateNoopIsm;
  fromJSON(object: any): MsgCreateNoopIsm;
  toJSON(message: MsgCreateNoopIsm): unknown;
  create<I extends Exact<DeepPartial<MsgCreateNoopIsm>, I>>(
    base?: I,
  ): MsgCreateNoopIsm;
  fromPartial<I extends Exact<DeepPartial<MsgCreateNoopIsm>, I>>(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgCreateNoopIsmResponse>, I>>(
    base?: I,
  ): MsgCreateNoopIsmResponse;
  fromPartial<I extends Exact<DeepPartial<MsgCreateNoopIsmResponse>, I>>(
    object: I,
  ): MsgCreateNoopIsmResponse;
};
export declare const MsgAnnounceValidator: {
  encode(message: MsgAnnounceValidator, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgAnnounceValidator;
  fromJSON(object: any): MsgAnnounceValidator;
  toJSON(message: MsgAnnounceValidator): unknown;
  create<I extends Exact<DeepPartial<MsgAnnounceValidator>, I>>(
    base?: I,
  ): MsgAnnounceValidator;
  fromPartial<I extends Exact<DeepPartial<MsgAnnounceValidator>, I>>(
    object: I,
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
  create<I extends Exact<DeepPartial<MsgAnnounceValidatorResponse>, I>>(
    base?: I,
  ): MsgAnnounceValidatorResponse;
  fromPartial<I extends Exact<DeepPartial<MsgAnnounceValidatorResponse>, I>>(
    _: I,
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
