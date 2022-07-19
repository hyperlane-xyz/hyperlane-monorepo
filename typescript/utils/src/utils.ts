import { ethers, utils } from 'ethers';

import { Checkpoint } from './types';
import { Address, Domain, HexString, ParsedMessage } from './types';

export function assert(predicate: any, errorMessage?: string) {
  if (!predicate) {
    throw new Error(errorMessage ?? 'Error');
  }
}

export function deepEquals(v1: any, v2: any) {
  return JSON.stringify(v1) === JSON.stringify(v2);
}

export const ensure0x = (hexstr: string) =>
  hexstr.startsWith('0x') ? hexstr : `0x${hexstr}`;

export const strip0x = (hexstr: string) =>
  hexstr.startsWith('0x') ? hexstr.slice(2) : hexstr;

/*
 * Gets the byte length of a hex string
 *
 * @param hexStr - the hex string
 * @return byteLength - length in bytes
 */
export function getHexStringByteLength(hexStr: string) {
  const len = strip0x(hexStr).length;

  // divide by 2 to get the byte length
  return len / 2;
}

export const stringToBytes32 = (s: string): string => {
  const str = Buffer.from(s.slice(0, 32), 'utf-8');
  const result = Buffer.alloc(32);
  str.copy(result);

  return ensure0x(result.toString('hex'));
};

export function addressToBytes32(address: Address): string {
  return ethers.utils
    .hexZeroPad(ethers.utils.hexStripZeros(address), 32)
    .toLowerCase();
}

export function bytes32ToAddress(bytes32: string): Address {
  return ethers.utils.getAddress(bytes32.slice(-40));
}

export function formatCallData<
  C extends ethers.Contract,
  I extends Parameters<C['interface']['encodeFunctionData']>,
>(destinationContract: C, functionName: I[0], functionArgs: I[1]): string {
  return destinationContract.interface.encodeFunctionData(
    functionName,
    functionArgs,
  );
}

export const formatMessage = (
  localDomain: Domain,
  senderAddr: Address,
  destinationDomain: Domain,
  recipientAddr: Address,
  body: HexString,
): string => {
  senderAddr = addressToBytes32(senderAddr);
  recipientAddr = addressToBytes32(recipientAddr);

  return ethers.utils.solidityPack(
    ['uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [localDomain, senderAddr, destinationDomain, recipientAddr, body],
  );
};

/**
 * Parse a serialized Abacus message from raw bytes.
 *
 * @param message
 * @returns
 */
export function parseMessage(message: string): ParsedMessage {
  const buf = Buffer.from(utils.arrayify(message));
  const origin = buf.readUInt32BE(0);
  const sender = utils.hexlify(buf.slice(4, 36));
  const destination = buf.readUInt32BE(36);
  const recipient = utils.hexlify(buf.slice(40, 72));
  const body = utils.hexlify(buf.slice(72));
  return { origin, sender, destination, recipient, body };
}

export function messageHash(message: HexString, leafIndex: number): string {
  return ethers.utils.solidityKeccak256(
    ['bytes', 'uint256'],
    [message, leafIndex],
  );
}

export function destinationAndNonce(
  destination: Domain,
  sequence: number,
): ethers.BigNumber {
  assert(destination < Math.pow(2, 32) - 1);
  assert(sequence < Math.pow(2, 32) - 1);

  return ethers.BigNumber.from(destination)
    .mul(ethers.BigNumber.from(2).pow(32))
    .add(ethers.BigNumber.from(sequence));
}

export function domainHash(domain: number): string {
  return ethers.utils.solidityKeccak256(
    ['uint32', 'string'],
    [domain, 'ABACUS'],
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Retries an async function when it raises an exception
// if all the tries fail it raises the last thrown exception
export async function retryAsync<T>(
  runner: () => T,
  attempts = 3,
  delay = 500,
) {
  let saveError;
  for (let i = 0; i < attempts; i++) {
    try {
      return runner();
    } catch (error) {
      saveError = error;
      await sleep(delay * (i + 1));
    }
  }
  throw saveError;
}

export function median(a: number[]): number {
  const sorted = a.slice().sort();
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 == 0 ? (sorted[mid] + sorted[mid + 1]) / 2 : sorted[mid];
  return median;
}

export function sum(a: number[]): number {
  return a.reduce((acc, i) => acc + i);
}

export function mean(a: number[]): number {
  return sum(a) / a.length;
}

export function stdDev(a: number[]): number {
  const xbar = mean(a);
  const squaredDifferences = a.map((x) => Math.pow(x - xbar, 2));
  return Math.sqrt(mean(squaredDifferences));
}

export function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    stream
      .setEncoding('utf8')
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', (err) => reject(err))
      .on('end', () => resolve(String.prototype.concat(...chunks)));
  });
}

export function isCheckpoint(obj: unknown): obj is Checkpoint {
  const c = obj as Partial<Checkpoint>;
  return (
    typeof obj == 'object' &&
    obj != null &&
    Number.isSafeInteger(c.index) &&
    ethers.utils.isHexString(c.root) &&
    ethers.utils.isHexString(c.signature)
  );
}
