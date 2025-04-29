import { utils } from 'ethers';
import { z } from 'zod';

/**
 * Schema for EVM log directive response
 * Format: [chainId, contract, indexed fields, unindexed fields]
 *
 * Fields:
 * - chainId: string - The chain ID where the log was emitted
 * - contract: address - The contract address that emitted the log
 * - indexed: bytes32[] - The indexed topics of the log
 * - unindexed: bytes - The unindexed data of the log
 */
export const EvmLogSchema = z.object({
  chainId: z.string(),
  contract: z.string(), // address
  indexed: z.array(z.string()), // bytes32[]
  unindexed: z.string(), // bytes
});

export type EvmLog = z.infer<typeof EvmLogSchema>;

// ABI types for encoding/decoding
const ABI_TYPES = ['string', 'address', 'bytes32[]', 'bytes'];

/**
 * Encodes an EVM log directive into a hex string
 * @param directive The EVM log directive to encode
 * @returns The ABI encoded hex string
 */
export function encodeEvmLog(directive: EvmLog): string {
  const abiCoder = new utils.AbiCoder();
  return abiCoder.encode(ABI_TYPES, [
    directive.chainId,
    directive.contract,
    directive.indexed,
    directive.unindexed,
  ]);
}

/**
 * Decodes a hex string into an EVM log directive
 * @param hexString The ABI encoded hex string to decode
 * @returns The decoded EVM log directive
 */
export function decodeEvmLog(hexString: string): EvmLog {
  const abiCoder = new utils.AbiCoder();
  const decoded = abiCoder.decode(ABI_TYPES, hexString);
  return {
    chainId: decoded[0],
    contract: decoded[1],
    indexed: decoded[2],
    unindexed: decoded[3],
  };
}
