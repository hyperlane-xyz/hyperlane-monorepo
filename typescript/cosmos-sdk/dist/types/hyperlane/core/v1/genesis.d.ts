import _m0 from 'protobufjs/minimal';

import { GenesisState as GenesisState1 } from '../interchain_security/v1/genesis';
import { GenesisState as GenesisState2 } from '../post_dispatch/v1/genesis';

import { Mailbox } from './types';

export declare const protobufPackage = 'hyperlane.core.v1';
/** GenesisState is the state that must be provided at genesis. */
export interface GenesisState {
  /** ism_genesis */
  ism_genesis?: GenesisState1 | undefined;
  /** post_dispatch_genesis */
  post_dispatch_genesis?: GenesisState2 | undefined;
  mailboxes: Mailbox[];
  messages: MailboxMessage[];
  ism_sequence: string;
  post_dispatch_sequence: string;
  app_sequence: string;
}
/** Mailbox message for genesis state */
export interface MailboxMessage {
  mailbox_id: string;
  message_id: Uint8Array;
}
export declare const GenesisState: {
  encode(message: GenesisState, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): GenesisState;
  fromJSON(object: any): GenesisState;
  toJSON(message: GenesisState): unknown;
  create<I extends Exact<DeepPartial<GenesisState>, I>>(base?: I): GenesisState;
  fromPartial<I extends Exact<DeepPartial<GenesisState>, I>>(
    object: I,
  ): GenesisState;
};
export declare const MailboxMessage: {
  encode(message: MailboxMessage, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): MailboxMessage;
  fromJSON(object: any): MailboxMessage;
  toJSON(message: MailboxMessage): unknown;
  create<I extends Exact<DeepPartial<MailboxMessage>, I>>(
    base?: I,
  ): MailboxMessage;
  fromPartial<I extends Exact<DeepPartial<MailboxMessage>, I>>(
    object: I,
  ): MailboxMessage;
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
