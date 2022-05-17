import { BytesLike, arrayify, hexlify } from '@ethersproject/bytes';
import { ethers } from 'ethers';

import { ChainMap, ChainName, Remotes } from './types';

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

export class MultiGeneric<Chain extends ChainName, Value> {
  constructor(protected readonly chainMap: ChainMap<Chain, Value>) {}

  protected get = (chain: Chain) => this.chainMap[chain];

  chainNames = () => Object.keys(this.chainMap) as Chain[];

  apply(fn: (n: Chain, dc: Value) => void) {
    for (const chain of this.chainNames()) {
      fn(chain, this.chainMap[chain]);
    }
  }

  map<Output>(fn: (n: Chain, dc: Value) => Output) {
    let entries: [Chain, Output][] = [];
    const chains = this.chainNames();
    for (const chain of chains) {
      entries.push([chain, fn(chain, this.chainMap[chain])]);
    }
    return Object.fromEntries(entries) as Record<Chain, Output>;
  }

  remotes = <Name extends Chain>(name: Name) =>
    this.chainNames().filter((key) => key !== name) as Remotes<Chain, Name>[];

  extendWithChain = <New extends Remotes<ChainName, Chain>>(
    chain: New,
    value: Value,
  ) =>
    new MultiGeneric<New & Chain, Value>({
      ...this.chainMap,
      [chain]: value,
    });

  knownChain = (chain: ChainName) => chain in this.chainMap;
}

export function inferChainMap<M>(map: M) {
  return map as M extends ChainMap<infer Chain, infer Value>
    ? Record<Chain, Value>
    : never;
}

export function objMapEntries<K extends string, I = any, O = any>(
  obj: Record<K, I>,
  func: (k: K, _: I) => O,
): [K, O][] {
  return Object.entries<I>(obj).map(([k, v]) => [k as K, func(k as K, v)]);
}

export function objMap<K extends string, I = any, O = any>(
  obj: Record<K, I>,
  func: (k: K, _: I) => O,
) {
  return Object.fromEntries<O>(objMapEntries<K, I, O>(obj, func)) as Record<
    K,
    O
  >;
}

// promiseObjectAll :: {k: Promise a} -> Promise {k: a}
export const promiseObjAll = <K extends string, V>(object: {
  [key in K]: Promise<V>;
}): Promise<Record<K, V>> => {
  const promiseList = Object.entries(object).map(([name, promise]) =>
    (promise as Promise<V>).then((result) => [name, result]),
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
