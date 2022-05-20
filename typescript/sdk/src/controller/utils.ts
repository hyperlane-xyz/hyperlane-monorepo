import { ethers } from 'ethers';

import { types } from '@abacus-network/utils';

import { canonizeId } from '../utils';

export interface Call {
  to: types.Address;
  data: ethers.utils.BytesLike;
}

// Returns the length (in bytes) of a BytesLike.
export function byteLength(bytesLike: ethers.utils.BytesLike): number {
  return ethers.utils.arrayify(bytesLike).length;
}

/**
 * Serialize a call to its packed ControllerMessage representation
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

export function normalizeCall(partial: Partial<Call>): Readonly<Call> {
  const to = ethers.utils.hexlify(canonizeId(partial.to!));
  const data = partial.data ?? '0x';

  return Object.freeze({
    to,
    data,
  });
}
