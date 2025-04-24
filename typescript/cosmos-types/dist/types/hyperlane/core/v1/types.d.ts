import _m0 from 'protobufjs/minimal.js';

export declare const protobufPackage = 'hyperlane.core.v1';
/** Mailbox ... */
export interface Mailbox {
  id: string;
  /** owner ... */
  owner: string;
  /** message_sent ... */
  message_sent: number;
  /** message_received ... */
  message_received: number;
  /** default_ism ... */
  default_ism: string;
  /** default_hook */
  default_hook: string;
  /** required_hook */
  required_hook: string;
  /** domain */
  local_domain: number;
}
export declare const Mailbox: {
  encode(message: Mailbox, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): Mailbox;
  fromJSON(object: any): Mailbox;
  toJSON(message: Mailbox): unknown;
  create<
    I extends {
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
    } & { [K in Exclude<keyof I, keyof Mailbox>]: never },
  >(
    base?: I | undefined,
  ): Mailbox;
  fromPartial<
    I_1 extends {
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
    } & { [K_1 in Exclude<keyof I_1, keyof Mailbox>]: never },
  >(
    object: I_1,
  ): Mailbox;
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
