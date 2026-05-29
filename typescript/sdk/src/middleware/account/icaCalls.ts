import { BigNumber, utils } from 'ethers';
import { z } from 'zod';
import {
  CallData,
  addressToBytes32,
  fromHexString,
  toHexString,
} from '@hyperlane-xyz/utils';

import { ZHash } from '../../metadata/customZodTypes.js';

export function encodeIcaCalls(calls: CallData[], salt: string) {
  return (
    salt +
    utils.defaultAbiCoder
      .encode(
        ['tuple(bytes32 to,uint256 value,bytes data)[]'],
        [
          calls.map((c) => ({
            to: addressToBytes32(c.to),
            value: c.value || 0,
            data: c.data,
          })),
        ],
      )
      .slice(2)
  );
}

// Convenience function to transform value strings to bignumber
export type RawCallData = {
  to: string;
  value?: string | number;
  data: string;
};

export function normalizeCalls(calls: RawCallData[]): CallData[] {
  return calls.map((call) => ({
    to: addressToBytes32(call.to),
    value: BigNumber.from(call.value || 0),
    data: call.data,
  }));
}

export function commitmentFromIcaCalls(
  calls: CallData[],
  salt: string,
): string {
  return utils.keccak256(encodeIcaCalls(calls, salt));
}

/**
 * Format of REVEAL message:
 * [   0:  1] MessageType.REVEAL (uint8)
 * [   1: 33] ICA ISM (bytes32)
 * [  33: 65] Commitment (bytes32)
 */
export function commitmentFromRevealMessage(message: string): string {
  const messageBuffer = fromHexString(message);

  // Validate minimum length (65 bytes: 1 byte type + 32 bytes ISM + 32 bytes commitment)
  if (messageBuffer.length < 65) {
    throw new Error(
      `Invalid reveal message: expected at least 65 bytes, got ${messageBuffer.length} bytes`,
    );
  }

  // Extract commitment from bytes 33-65 (32 bytes)
  const commitment = messageBuffer.subarray(33, 65);

  return toHexString(commitment);
}

const PostCallsBaseSchema = z.object({
  calls: z
    .array(
      z.object({
        to: ZHash,
        data: z.string(),
        value: z.string().optional(),
      }),
    )
    .min(1),
  relayers: z.array(ZHash),
  salt: ZHash,
  ismOverride: ZHash.optional(),
  originDomain: z.number(),
});

// Legacy shape: ICA derived from dispatch tx receipt events
const PostCallsLegacySchema = PostCallsBaseSchema.extend({
  commitmentDispatchTx: ZHash,
});

// New shape: ICA derived directly from destination + owner
const PostCallsIcaSchema = PostCallsBaseSchema.extend({
  destinationDomain: z.number(),
  owner: ZHash,
  userSalt: ZHash.optional(),
});

export const PostCallsSchema = z.union([
  PostCallsIcaSchema,
  PostCallsLegacySchema,
]);

export type PostCallsType = z.infer<typeof PostCallsSchema>;
export type PostCallsLegacyType = z.infer<typeof PostCallsLegacySchema>;
export type PostCallsIcaType = z.infer<typeof PostCallsIcaSchema>;

export function isPostCallsIca(data: PostCallsType): data is PostCallsIcaType {
  return 'destinationDomain' in data && 'owner' in data;
}
