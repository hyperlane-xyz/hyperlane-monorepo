import { BigNumber, ethers, utils } from 'ethers';

import {
  Address,
  Checkpoint,
  Domain,
  HexString,
  ParsedLegacyMultisigIsmMetadata,
  ParsedMessage,
} from './types';

export function exclude<T>(item: T, list: T[]) {
  return list.filter((i) => i !== item);
}

export function assert(predicate: any, errorMessage?: string) {
  if (!predicate) {
    throw new Error(errorMessage ?? 'Error');
  }
}

export function deepEquals(v1: any, v2: any) {
  return JSON.stringify(v1) === JSON.stringify(v2);
}

export function eqAddress(a: string, b: string) {
  return ethers.utils.getAddress(a) === ethers.utils.getAddress(b);
}

export const ensure0x = (hexstr: string) =>
  hexstr.startsWith('0x') ? hexstr : `0x${hexstr}`;

export const strip0x = (hexstr: string) =>
  hexstr.startsWith('0x') ? hexstr.slice(2) : hexstr;

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

export const parseLegacyMultisigIsmMetadata = (
  metadata: string,
): ParsedLegacyMultisigIsmMetadata => {
  const MERKLE_ROOT_OFFSET = 0;
  const MERKLE_INDEX_OFFSET = 32;
  const ORIGIN_MAILBOX_OFFSET = 36;
  const MERKLE_PROOF_OFFSET = 68;
  const THRESHOLD_OFFSET = 1092;
  const SIGNATURES_OFFSET = 1093;
  const SIGNATURE_LENGTH = 65;

  const buf = Buffer.from(utils.arrayify(metadata));
  const checkpointRoot = utils.hexlify(
    buf.slice(MERKLE_ROOT_OFFSET, MERKLE_INDEX_OFFSET),
  );
  const checkpointIndex = BigNumber.from(
    utils.hexlify(buf.slice(MERKLE_INDEX_OFFSET, ORIGIN_MAILBOX_OFFSET)),
  ).toNumber();
  const originMailbox = utils.hexlify(
    buf.slice(ORIGIN_MAILBOX_OFFSET, MERKLE_PROOF_OFFSET),
  );
  const parseBytesArray = (start: number, count: number, size: number) => {
    return [...Array(count).keys()].map((i) =>
      utils.hexlify(buf.slice(start + size * i, start + size * (i + 1))),
    );
  };
  const proof = parseBytesArray(MERKLE_PROOF_OFFSET, 32, 32);
  const threshold = BigNumber.from(
    utils.hexlify(buf.slice(THRESHOLD_OFFSET, SIGNATURES_OFFSET)),
  ).toNumber();
  const signatures = parseBytesArray(
    SIGNATURES_OFFSET,
    threshold,
    SIGNATURE_LENGTH,
  );
  const VALIDATORS_OFFSET = SIGNATURES_OFFSET + threshold * SIGNATURE_LENGTH;
  const addressesCount = buf.slice(VALIDATORS_OFFSET).length / 32;
  const validators = parseBytesArray(VALIDATORS_OFFSET, addressesCount, 32);
  return {
    checkpointRoot,
    checkpointIndex,
    originMailbox,
    proof,
    signatures,
    validators,
  };
};

export const formatLegacyMultisigIsmMetadata = (
  metadata: ParsedLegacyMultisigIsmMetadata,
): string => {
  return ethers.utils.solidityPack(
    [
      'bytes32',
      'uint32',
      'bytes32',
      'bytes32[32]',
      'uint8',
      'bytes',
      'address[]',
    ],
    [
      metadata.checkpointRoot,
      metadata.checkpointIndex,
      addressToBytes32(metadata.originMailbox),
      metadata.proof,
      metadata.signatures.length,
      ethers.utils.hexConcat(metadata.signatures),
      metadata.validators,
    ],
  );
};

/**
 * JS Implementation of solidity/contracts/libs/Message.sol#formatMessage
 * @returns Hex string of the packed message
 */
export const formatMessage = (
  version: number | BigNumber,
  nonce: number | BigNumber,
  originDomain: Domain,
  senderAddr: Address,
  destinationDomain: Domain,
  recipientAddr: Address,
  body: HexString,
): HexString => {
  senderAddr = addressToBytes32(senderAddr);
  recipientAddr = addressToBytes32(recipientAddr);

  return ethers.utils.solidityPack(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [
      version,
      nonce,
      originDomain,
      senderAddr,
      destinationDomain,
      recipientAddr,
      body,
    ],
  );
};

/**
 * Get ID given message bytes
 * @param message Hex string of the packed message (see formatMessage)
 * @returns Hex string of message id
 */
export function messageId(message: HexString): HexString {
  return ethers.utils.solidityKeccak256(['bytes'], [message]);
}

/**
 * Parse a serialized Hyperlane message from raw bytes.
 *
 * @param message
 * @returns
 */
export function parseMessage(message: string): ParsedMessage {
  const VERSION_OFFSET = 0;
  const NONCE_OFFSET = 1;
  const ORIGIN_OFFSET = 5;
  const SENDER_OFFSET = 9;
  const DESTINATION_OFFSET = 41;
  const RECIPIENT_OFFSET = 45;
  const BODY_OFFSET = 77;

  const buf = Buffer.from(utils.arrayify(message));
  const version = buf.readUint8(VERSION_OFFSET);
  const nonce = buf.readUInt32BE(NONCE_OFFSET);
  const origin = buf.readUInt32BE(ORIGIN_OFFSET);
  const sender = utils.hexlify(buf.slice(SENDER_OFFSET, DESTINATION_OFFSET));
  const destination = buf.readUInt32BE(DESTINATION_OFFSET);
  const recipient = utils.hexlify(buf.slice(RECIPIENT_OFFSET, BODY_OFFSET));
  const body = utils.hexlify(buf.slice(BODY_OFFSET));
  return { version, nonce, origin, sender, destination, recipient, body };
}

export function domainHash(domain: number, mailbox: string): string {
  return ethers.utils.solidityKeccak256(
    ['uint32', 'bytes32', 'string'],
    [domain, addressToBytes32(mailbox), 'HYPERLANE'],
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Retries an async function if it raises an exception,
// with exponential backoff.
// If all the tries fail it raises the last thrown exception
export async function retryAsync<T>(
  runner: () => T,
  attempts = 5,
  baseRetryMs = 50,
) {
  let saveError;
  for (let i = 0; i < attempts; i++) {
    try {
      return runner();
    } catch (error) {
      saveError = error;
      await sleep(baseRetryMs * 2 ** i);
    }
  }
  throw saveError;
}

export async function pollAsync<T>(
  runner: () => Promise<T>,
  delayMs = 500,
  maxAttempts: number | undefined = undefined,
) {
  let attempts = 0;
  let saveError;
  while (!maxAttempts || attempts < maxAttempts) {
    try {
      const ret = await runner();
      return ret;
    } catch (error) {
      saveError = error;
      attempts += 1;
      await sleep(delayMs);
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

export function isCheckpoint(obj: any): obj is Checkpoint {
  const isValidSignature =
    typeof obj.signature === 'string'
      ? ethers.utils.isHexString(obj.signature)
      : ethers.utils.isHexString(obj.signature.r) &&
        ethers.utils.isHexString(obj.signature.s) &&
        Number.isSafeInteger(obj.signature.v);

  const isValidRoot = ethers.utils.isHexString(obj.root);
  const isValidIndex = Number.isSafeInteger(obj.index);
  return isValidIndex && isValidRoot && isValidSignature;
}

/**
 * Wait up to a given amount of time, and throw an error if the promise does not resolve in time.
 * @param promise The promise to timeout on.
 * @param timeoutMs How long to wait for the promise in milliseconds.
 * @param message The error message if a timeout occurs.
 */
export function timeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
  message = 'Timeout reached',
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(resolve).catch(reject);
  });
}

// Should be used instead of referencing process directly in case we don't
// run in node.js
export function safelyAccessEnvVar(name: string) {
  try {
    return process.env[name];
  } catch (error) {
    return undefined;
  }
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set#implementing_basic_set_operations
export function difference<T>(a: Set<T>, b: Set<T>) {
  const _difference = new Set(a);
  for (const elem of b) {
    _difference.delete(elem);
  }
  return _difference;
}

export function symmetricDifference<T>(a: Set<T>, b: Set<T>) {
  const _difference = new Set(a);
  for (const elem of b) {
    if (_difference.has(elem)) {
      _difference.delete(elem);
    } else {
      _difference.add(elem);
    }
  }
  return _difference;
}

export function setEquality<T>(a: Set<T>, b: Set<T>) {
  return symmetricDifference(a, b).size === 0;
}

export async function runWithTimeout<T>(
  timeoutMs: number,
  callback: () => Promise<T>,
): Promise<T | void> {
  let timeout: NodeJS.Timeout;
  const timeoutProm = new Promise<void>(
    (_, reject) =>
      (timeout = setTimeout(
        () => reject(new Error(`Timed out in ${timeoutMs}ms.`)),
        timeoutMs,
      )),
  );
  const ret = Promise.race([callback(), timeoutProm]);
  // @ts-ignore timeout gets set immediately by the promise constructor
  clearTimeout(timeout);
  return ret;
}
