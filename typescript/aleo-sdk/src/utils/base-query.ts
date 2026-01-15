import { Plaintext } from '@provablehq/sdk';

import { assert, isNullish } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';

/**
 * Helper function to query a mapping value from an Aleo program.
 *
 * @param aleoClient - The Aleo network client
 * @param programId - The program ID to query
 * @param mappingName - The name of the mapping
 * @param key - The key to look up in the mapping
 * @param formatter - Parsing function to transform the raw result into type T
 * @returns The parsed mapping value, or undefined if not found
 */
export async function tryQueryMappingValue<T>(
  aleoClient: AnyAleoNetworkClient,
  programId: string,
  mappingName: string,
  key: string,
  formatter: (raw: unknown) => T,
): Promise<T | undefined> {
  try {
    const result: string | null = await aleoClient.getProgramMappingValue(
      programId,
      mappingName,
      key,
    );

    return !isNullish(result)
      ? formatter(Plaintext.fromString(result).toObject())
      : undefined;
  } catch (err) {
    throw new Error(
      `Failed to query mapping value for program ${programId}/${mappingName}/${key}: ${err}`,
    );
  }
}

/**
 * Helper function to query a mapping value from an Aleo program.
 *
 * @param aleoClient - The Aleo network client
 * @param programId - The program ID to query
 * @param mappingName - The name of the mapping
 * @param key - The key to look up in the mapping
 * @param formatter - Parsing function to transform the raw result into type T
 * @returns The parsed mapping value
 */
export async function queryMappingValue<T>(
  aleoClient: AnyAleoNetworkClient,
  programId: string,
  mappingName: string,
  key: string,
  formatter: (raw: unknown) => T,
): Promise<T> {
  const result = await tryQueryMappingValue(
    aleoClient,
    programId,
    mappingName,
    key,
    formatter,
  );

  assert(
    !isNullish(result),
    `Value not found in mapping ${programId}/${mappingName}/${key}`,
  );

  return result;
}
