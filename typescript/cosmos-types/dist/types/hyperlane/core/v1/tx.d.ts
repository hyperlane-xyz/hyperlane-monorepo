import _m0 from 'protobufjs/minimal.js';

export declare const protobufPackage = 'hyperlane.core.v1';
/** MsgCreateMailbox ... */
export interface MsgCreateMailbox {
  /** owner is the message sender. */
  owner: string;
  /** local domain */
  local_domain: number;
  default_ism: string;
  /** default_hook ... */
  default_hook: string;
  /** required_hook ... */
  required_hook: string;
}
/** MsgCreateMailboxResponse ... */
export interface MsgCreateMailboxResponse {
  id: string;
}
/** MsgSetMailbox ... */
export interface MsgSetMailbox {
  /** owner is the message sender. */
  owner: string;
  /** mailbox_id */
  mailbox_id: string;
  /** default_ism ... */
  default_ism: string;
  /** default_hook ... */
  default_hook: string;
  /** required_hook ... */
  required_hook: string;
  /** new_owner ... */
  new_owner: string;
}
/** MsgSetMailboxResponse ... */
export interface MsgSetMailboxResponse {}
/** MsgProcessMessage ... */
export interface MsgProcessMessage {
  /** mailbox_id ... */
  mailbox_id: string;
  /** relayer ... */
  relayer: string;
  /** metadata ... */
  metadata: string;
  /** message ... */
  message: string;
}
/** MsgProcessMessageResponse ... */
export interface MsgProcessMessageResponse {}
export declare const MsgCreateMailbox: {
  encode(message: MsgCreateMailbox, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgCreateMailbox;
  fromJSON(object: any): MsgCreateMailbox;
  toJSON(message: MsgCreateMailbox): unknown;
  create<
    I extends {
      owner?: string | undefined;
      local_domain?: number | undefined;
      default_ism?: string | undefined;
      default_hook?: string | undefined;
      required_hook?: string | undefined;
    } & {
      owner?: string | undefined;
      local_domain?: number | undefined;
      default_ism?: string | undefined;
      default_hook?: string | undefined;
      required_hook?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgCreateMailbox>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateMailbox;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      local_domain?: number | undefined;
      default_ism?: string | undefined;
      default_hook?: string | undefined;
      required_hook?: string | undefined;
    } & {
      owner?: string | undefined;
      local_domain?: number | undefined;
      default_ism?: string | undefined;
      default_hook?: string | undefined;
      required_hook?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgCreateMailbox>]: never },
  >(
    object: I_1,
  ): MsgCreateMailbox;
};
export declare const MsgCreateMailboxResponse: {
  encode(message: MsgCreateMailboxResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgCreateMailboxResponse;
  fromJSON(object: any): MsgCreateMailboxResponse;
  toJSON(message: MsgCreateMailboxResponse): unknown;
  create<
    I extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K in Exclude<keyof I, 'id'>]: never },
  >(
    base?: I | undefined,
  ): MsgCreateMailboxResponse;
  fromPartial<
    I_1 extends {
      id?: string | undefined;
    } & {
      id?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'id'>]: never },
  >(
    object: I_1,
  ): MsgCreateMailboxResponse;
};
export declare const MsgSetMailbox: {
  encode(message: MsgSetMailbox, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgSetMailbox;
  fromJSON(object: any): MsgSetMailbox;
  toJSON(message: MsgSetMailbox): unknown;
  create<
    I extends {
      owner?: string | undefined;
      mailbox_id?: string | undefined;
      default_ism?: string | undefined;
      default_hook?: string | undefined;
      required_hook?: string | undefined;
      new_owner?: string | undefined;
    } & {
      owner?: string | undefined;
      mailbox_id?: string | undefined;
      default_ism?: string | undefined;
      default_hook?: string | undefined;
      required_hook?: string | undefined;
      new_owner?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgSetMailbox>]: never },
  >(
    base?: I | undefined,
  ): MsgSetMailbox;
  fromPartial<
    I_1 extends {
      owner?: string | undefined;
      mailbox_id?: string | undefined;
      default_ism?: string | undefined;
      default_hook?: string | undefined;
      required_hook?: string | undefined;
      new_owner?: string | undefined;
    } & {
      owner?: string | undefined;
      mailbox_id?: string | undefined;
      default_ism?: string | undefined;
      default_hook?: string | undefined;
      required_hook?: string | undefined;
      new_owner?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgSetMailbox>]: never },
  >(
    object: I_1,
  ): MsgSetMailbox;
};
export declare const MsgSetMailboxResponse: {
  encode(_: MsgSetMailboxResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgSetMailboxResponse;
  fromJSON(_: any): MsgSetMailboxResponse;
  toJSON(_: MsgSetMailboxResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgSetMailboxResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgSetMailboxResponse;
};
export declare const MsgProcessMessage: {
  encode(message: MsgProcessMessage, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MsgProcessMessage;
  fromJSON(object: any): MsgProcessMessage;
  toJSON(message: MsgProcessMessage): unknown;
  create<
    I extends {
      mailbox_id?: string | undefined;
      relayer?: string | undefined;
      metadata?: string | undefined;
      message?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      relayer?: string | undefined;
      metadata?: string | undefined;
      message?: string | undefined;
    } & { [K in Exclude<keyof I, keyof MsgProcessMessage>]: never },
  >(
    base?: I | undefined,
  ): MsgProcessMessage;
  fromPartial<
    I_1 extends {
      mailbox_id?: string | undefined;
      relayer?: string | undefined;
      metadata?: string | undefined;
      message?: string | undefined;
    } & {
      mailbox_id?: string | undefined;
      relayer?: string | undefined;
      metadata?: string | undefined;
      message?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof MsgProcessMessage>]: never },
  >(
    object: I_1,
  ): MsgProcessMessage;
};
export declare const MsgProcessMessageResponse: {
  encode(_: MsgProcessMessageResponse, writer?: _m0.Writer): _m0.Writer;
  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): MsgProcessMessageResponse;
  fromJSON(_: any): MsgProcessMessageResponse;
  toJSON(_: MsgProcessMessageResponse): unknown;
  create<I extends {} & {} & { [K in Exclude<keyof I, never>]: never }>(
    base?: I | undefined,
  ): MsgProcessMessageResponse;
  fromPartial<
    I_1 extends {} & {} & { [K_1 in Exclude<keyof I_1, never>]: never },
  >(
    _: I_1,
  ): MsgProcessMessageResponse;
};
/** Msg defines the module Msg service. */
export interface Msg {
  /** CreateMailbox ... */
  CreateMailbox(request: MsgCreateMailbox): Promise<MsgCreateMailboxResponse>;
  /** SetMailbox ... */
  SetMailbox(request: MsgSetMailbox): Promise<MsgSetMailboxResponse>;
  /** ProcessMessage ... */
  ProcessMessage(
    request: MsgProcessMessage,
  ): Promise<MsgProcessMessageResponse>;
}
export declare const MsgServiceName = 'hyperlane.core.v1.Msg';
export declare class MsgClientImpl implements Msg {
  private readonly rpc;
  private readonly service;
  constructor(
    rpc: Rpc,
    opts?: {
      service?: string;
    },
  );
  CreateMailbox(request: MsgCreateMailbox): Promise<MsgCreateMailboxResponse>;
  SetMailbox(request: MsgSetMailbox): Promise<MsgSetMailboxResponse>;
  ProcessMessage(
    request: MsgProcessMessage,
  ): Promise<MsgProcessMessageResponse>;
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
