import { Plaintext } from '@provablehq/sdk';

import { assert, isNullish, retryAsync } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';

import { RETRY_ATTEMPTS, RETRY_DELAY_MS } from './helper.js';

/**
 * Retrieves the expected nonce for the next artifact to be created by an artifact manager.
 *
 * This function queries an artifact manager's `nonce` mapping to get the current count of
 * created artifacts. This nonce value must be retrieved BEFORE submitting the artifact creation
 * transaction, as it will be used to look up the newly created artifact's address from the
 * manager's address registry after the transaction is confirmed.
 *
 * The typical usage pattern for any artifact manager (ISM manager, hook manager, etc.) is:
 * 1. Call this function to get the expected nonce
 * 2. Submit the artifact creation transaction
 * 3. Use the nonce with `getNewIsmAddress()` or similar to retrieve the new artifact's address
 *
 * @param aleoClient - The Aleo network client for querying contract state
 * @param ismManagerProgramId - The program ID of the artifact manager contract
 * @returns The nonce as an Aleo u32 string (e.g., "0u32", "1u32"), defaulting to "0u32" if no artifacts have been created yet
 *
 * @example
 * ```typescript
 * // Works with any artifact manager (ISM, hook, etc.)
 * const expectedNonce = await getNewContractExpectedNonce(client, managerProgramId);
 * const receipt = await signer.sendAndConfirmTransaction(createArtifactTx);
 * const artifactAddress = await getNewArtifactAddress(client, managerProgramId, expectedNonce);
 * ```
 */
export async function getNewContractExpectedNonce(
  aleoClient: AnyAleoNetworkClient,
  ismManagerProgramId: string,
): Promise<string> {
  let nonce = await retryAsync(
    () =>
      aleoClient.getProgramMappingValue(ismManagerProgramId, 'nonce', 'true'),
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
  );

  if (nonce === null) {
    nonce = '0u32';
  }

  return nonce;
}

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
