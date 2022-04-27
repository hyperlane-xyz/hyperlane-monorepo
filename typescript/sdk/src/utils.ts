import { arrayify, BytesLike, hexlify } from '@ethersproject/bytes';
import { ethers } from 'ethers';
import { ChainName, ChainMap, Remotes } from './types';

export type Address = string;

/**
 * Converts a 20-byte (or other length) ID to a 32-byte ID.
 * Ensures that a bytes-like is 32 long. left-padding with 0s if not.
 *
 * @param data A string or array of bytes to canonize
 * @returns A Uint8Array of length 32
 */
export function canonizeId(data: BytesLike): Uint8Array {
  if (!data) throw new Error('Bad input. Undefined');
  const buf = ethers.utils.arrayify(data);
  if (buf.length > 32) {
    throw new Error('Too long');
  }
  if (buf.length !== 20 && buf.length != 32) {
    throw new Error('bad input, expect address or bytes32');
  }
  return ethers.utils.zeroPad(buf, 32);
}

/**
 * Converts an Abacus ID of 20 or 32 bytes to the corresponding EVM Address.
 *
 * For 32-byte IDs this enforces the EVM convention of using the LAST 20 bytes.
 *
 * @param data The data to truncate
 * @returns A 20-byte, 0x-prepended hex string representing the EVM Address
 * @throws if the data is not 20 or 32 bytes
 */
export function evmId(data: BytesLike): Address {
  const u8a = arrayify(data);

  if (u8a.length === 32) {
    return hexlify(u8a.slice(12, 32));
  } else if (u8a.length === 20) {
    return hexlify(u8a);
  } else {
    throw new Error(`Invalid id length. expected 20 or 32. Got ${u8a.length}`);
  }
}

/**
 * Sleep async for some time.
 *
 * @param ms the number of milliseconds to sleep
 * @returns A delay promise
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MultiGeneric<Value, Networks extends ChainName = ChainName> {
  constructor(protected readonly domainMap: ChainMap<Networks, Value>) {}

  protected get = (network: Networks) => this.domainMap[network];

  protected entries = () =>
    Object.entries(this.domainMap) as Array<[Networks, Value]>;

  protected values = (): Array<Value> => Object.values(this.domainMap);

  networks = () => Object.keys(this.domainMap) as Networks[];

  remotes = <Name extends Networks>(name: Name) =>
    this.networks().filter((key) => key !== name) as Remotes<Networks, Name>[];

  extendWithDomain = <New extends Remotes<ChainName, Networks>>(
    network: New,
    value: Value,
  ) =>
    new MultiGeneric<Value, New & Networks>({
      ...this.domainMap,
      [network]: value,
    });

  knownDomain = (network: ChainName) => network in this.domainMap;
}

export function inferChainMap<M>(map: M) {
  return map as M extends ChainMap<infer Networks, infer Value>
    ? Record<Networks, Value>
    : never;
}

export function objMapEntries<N extends ChainName, I, O>(
  obj: ChainMap<N, I>,
  func: (k: N, _: I) => O,
): [N, O][] {
  return Object.entries<I>(obj).map(([k, v]) => [k as N, func(k as N, v)]);
}

export function objMap<N extends ChainName, I, O>(
  obj: Record<N, I>,
  func: (k: N, _: I) => O,
) {
  return Object.fromEntries<O>(objMapEntries<N, I, O>(obj, func)) as Record<
    N,
    O
  >;
}

export interface IConstructor<T> {
  new (...args: any[]): T;
}

type PromiseValues<TO> = {
  [TK in keyof TO]: Promise<TO[TK]>;
};

// promiseObjectAll :: {k: Promise a} -> Promise {k: a}
export const promiseObjAll = <T>(object: PromiseValues<T>): Promise<T> => {
  const promiseList = Object.entries(object).map(([name, promise]) =>
    (promise as Promise<any>).then((result) => [name, result]),
  );
  return Promise.all(promiseList).then(Object.fromEntries);
};

export const utils = {
  objMap,
  promiseObjAll,
  canonizeId,
  evmId,
  delay,
};
