import _m0 from 'protobufjs/minimal.js';

export declare const protobufPackage = 'hyperlane.core.module.v1';
/**
 * Module is the app config object of the module.
 * Learn more: https://docs.cosmos.network/main/building-modules/depinject
 */
export interface Module {
  /**
   * authority defines the custom module authority.
   * if not set, defaults to the governance module.
   */
  authority: string;
}
export declare const Module: {
  encode(message: Module, writer?: _m0.Writer): _m0.Writer;
  decode(input: _m0.Reader | Uint8Array, length?: number): Module;
  fromJSON(object: any): Module;
  toJSON(message: Module): unknown;
  create<
    I extends {
      authority?: string | undefined;
    } & {
      authority?: string | undefined;
    } & { [K in Exclude<keyof I, 'authority'>]: never },
  >(
    base?: I | undefined,
  ): Module;
  fromPartial<
    I_1 extends {
      authority?: string | undefined;
    } & {
      authority?: string | undefined;
    } & { [K_1 in Exclude<keyof I_1, 'authority'>]: never },
  >(
    object: I_1,
  ): Module;
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
//# sourceMappingURL=module.d.ts.map
