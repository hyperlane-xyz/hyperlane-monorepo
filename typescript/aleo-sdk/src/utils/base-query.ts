import { Plaintext } from '@provablehq/sdk';

import { assert, isNullish } from '@hyperlane-xyz/utils';

import { AnyAleoNetworkClient } from '../clients/base.js';

/**
 * Helper function to query a mapping value from an Aleo program.
 * This is extracted from AleoBase.queryMappingValue() to be used as a standalone function.
 *
 * @param aleoClient - The Aleo network client
 * @param programId - The program ID to query
 * @param mappingName - The name of the mapping
 * @param key - The key to look up in the mapping
 * @param formatter - Optional parsing function to transform the raw result into type T
 * @returns The parsed mapping value, or undefined if not found
 */
export async function queryMappingValue<T>(
  aleoClient: AnyAleoNetworkClient,
  programId: string,
  mappingName: string,
  key: string,
  formatter: (raw: unknown) => T,
): Promise<T> {
  try {
    const result = await aleoClient.getProgramMappingValue(
      programId,
      mappingName,
      key,
    );

    assert(
      !isNullish(result),
      `Expected value to be defined in mapping ${mappingName} and key ${key}`,
    );

    const parsed = Plaintext.fromString(result).toObject();
    return formatter ? formatter(parsed) : parsed;
  } catch (err) {
    throw new Error(
      `Failed to query mapping value for program ${programId}/${mappingName}/${key}: ${err}`,
    );
  }
}
