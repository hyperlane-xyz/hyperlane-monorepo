import _m0 from 'protobufjs/minimal.js';

export declare const protobufPackage = 'hyperlane.warp.v1';
/** RemoteTransfer ... */
export interface RemoteTransfer {
  destination_domain: number;
  recipient_address: string;
}
export declare const RemoteTransfer: {
  encode(message: RemoteTransfer, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): RemoteTransfer;
  fromJSON(object: any): RemoteTransfer;
  toJSON(message: RemoteTransfer): unknown;
  create<
    I extends {
      destination_domain?: number | undefined;
      recipient_address?: string | undefined;
    } & {
      destination_domain?: number | undefined;
      recipient_address?: string | undefined;
    } & { [K in Exclude<keyof I, keyof RemoteTransfer>]: never },
  >(
    base?: I | undefined,
  ): RemoteTransfer;
  fromPartial<
    I_1 extends {
      destination_domain?: number | undefined;
      recipient_address?: string | undefined;
    } & {
      destination_domain?: number | undefined;
      recipient_address?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof RemoteTransfer>]: never },
  >(
    object: I_1,
  ): RemoteTransfer;
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
