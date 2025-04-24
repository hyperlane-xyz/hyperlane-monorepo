import _m0 from 'protobufjs/minimal.js';

export declare const protobufPackage = 'hyperlane.core.v1';
/** Dispatch ... */
export interface Dispatch {
  /** origin_mailbox_id ... */
  origin_mailbox_id: string;
  /** sender ... */
  sender: string;
  /** destination ... */
  destination: number;
  /** recipient ... */
  recipient: string;
  /** message ... */
  message: string;
}
/** Process ... */
export interface Process {
  /** origin_mailbox_id ... */
  origin_mailbox_id: string;
  /** origin ... */
  origin: number;
  /** sender ... */
  sender: string;
  /** recipient ... */
  recipient: string;
  /** message_id ... */
  message_id: string;
  /** message ... */
  message: string;
}
export declare const Dispatch: {
  encode(message: Dispatch, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): Dispatch;
  fromJSON(object: any): Dispatch;
  toJSON(message: Dispatch): unknown;
  create<
    I extends {
      origin_mailbox_id?: string | undefined;
      sender?: string | undefined;
      destination?: number | undefined;
      recipient?: string | undefined;
      message?: string | undefined;
    } & {
      origin_mailbox_id?: string | undefined;
      sender?: string | undefined;
      destination?: number | undefined;
      recipient?: string | undefined;
      message?: string | undefined;
    } & { [K in Exclude<keyof I, keyof Dispatch>]: never },
  >(
    base?: I | undefined,
  ): Dispatch;
  fromPartial<
    I_1 extends {
      origin_mailbox_id?: string | undefined;
      sender?: string | undefined;
      destination?: number | undefined;
      recipient?: string | undefined;
      message?: string | undefined;
    } & {
      origin_mailbox_id?: string | undefined;
      sender?: string | undefined;
      destination?: number | undefined;
      recipient?: string | undefined;
      message?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof Dispatch>]: never },
  >(
    object: I_1,
  ): Dispatch;
};
export declare const Process: {
  encode(message: Process, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): Process;
  fromJSON(object: any): Process;
  toJSON(message: Process): unknown;
  create<
    I extends {
      origin_mailbox_id?: string | undefined;
      origin?: number | undefined;
      sender?: string | undefined;
      recipient?: string | undefined;
      message_id?: string | undefined;
      message?: string | undefined;
    } & {
      origin_mailbox_id?: string | undefined;
      origin?: number | undefined;
      sender?: string | undefined;
      recipient?: string | undefined;
      message_id?: string | undefined;
      message?: string | undefined;
    } & { [K in Exclude<keyof I, keyof Process>]: never },
  >(
    base?: I | undefined,
  ): Process;
  fromPartial<
    I_1 extends {
      origin_mailbox_id?: string | undefined;
      origin?: number | undefined;
      sender?: string | undefined;
      recipient?: string | undefined;
      message_id?: string | undefined;
      message?: string | undefined;
    } & {
      origin_mailbox_id?: string | undefined;
      origin?: number | undefined;
      sender?: string | undefined;
      recipient?: string | undefined;
      message_id?: string | undefined;
      message?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof Process>]: never },
  >(
    object: I_1,
  ): Process;
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
