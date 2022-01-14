import { ethers } from 'ethers';
import { Call } from '.';
import { canonizeId } from '../../utils';

// Returns the length (in bytes) of a BytesLike.
export function byteLength(bytesLike: ethers.utils.BytesLike): number {
  return ethers.utils.arrayify(bytesLike).length;
}

/**
 * Serialize a call to its packed Optics governance representation
 * @param call The function call to serialize
 * @returns The serialized function call, as a '0x'-prepended hex string
 */
export function serializeCall(call: Call): string {
  const { to, data } = call;
  const dataLen = byteLength(data);

  if (!to || !data) {
    throw new Error(`Missing data in Call: \n  ${call}`);
  }

  return ethers.utils.solidityPack(
    ['bytes32', 'uint32', 'bytes'],
    [to, dataLen, data],
  );
}

/**
 * Serialize a call array to its packed Optics governance representation
 * @param batch The function calls to serialize
 * @returns The serialized function calls, as a '0x'-prepended hex string
 */
export function serializeCalls(batch: Call[]): string {
  return ethers.utils.hexConcat([
    [batch.length % 256], // 1 byte length of Call array
    ...batch.map(serializeCall), // each serialized call in turn
  ]);
}

/**
 * Calculates the hash commitment to a batch of calls
 * @param batch The function calls to be committed
 * @returns The hash commitment to the calls
 */
export function batchHash(batch: Call[]): string {
  return ethers.utils.keccak256(serializeCalls(batch));
}

export function associateRemotes(
  remoteCalls: Map<number, Call[]>,
): [number[], Call[][]] {
  const domains = [];
  const calls = [];
  for (const [key, value] of remoteCalls) {
    domains.push(key);
    calls.push(value);
  }
  return [domains, calls];
}

export function normalizeCall(partial: Partial<Call>): Readonly<Call> {
  const to = ethers.utils.hexlify(canonizeId(partial.to));
  const data = partial.data ?? '0x';

  return Object.freeze({
    to,
    data,
  });
}
