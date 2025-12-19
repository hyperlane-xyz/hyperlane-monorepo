import { assert } from '@hyperlane-xyz/utils';

import { AnyAleoNetworkClient } from '../clients/base.js';
import { queryMappingValue } from '../utils/base-query.js';
import { fromAleoAddress } from '../utils/helper.js';
import { AleoIsmType } from '../utils/types.js';

/**
 * Type guard to check if a number is a valid AleoIsmType
 */
function isAleoIsmType(maybeIsmType: number): maybeIsmType is AleoIsmType {
  switch (maybeIsmType) {
    case AleoIsmType.TEST_ISM:
    case AleoIsmType.ROUTING:
    case AleoIsmType.MERKLE_ROOT_MULTISIG:
    case AleoIsmType.MESSAGE_ID_MULTISIG:
      return true;
  }

  return false;
}

/**
 * Query the ISM type for a given ISM address.
 *
 * @param aleoClient - The Aleo network client
 * @param ismAddress - The full ISM address (e.g., "ism_manager.aleo/aleo1...")
 * @returns The ISM type
 */
export async function getIsmType(
  aleoClient: AnyAleoNetworkClient,
  ismAddress: string,
): Promise<AleoIsmType> {
  const { address, programId } = fromAleoAddress(ismAddress);

  const result = await queryMappingValue(
    aleoClient,
    programId,
    'isms',
    address,
    (raw) => {
      assert(
        typeof raw === 'number',
        `Expected ISM type to be a number but got ${typeof raw}`,
      );

      return raw;
    },
  );

  assert(
    isAleoIsmType(result),
    `Unknown ISM type ${result} for address: ${ismAddress}`,
  );

  return result;
}

/**
 * Query the configuration for a Test ISM (Noop ISM).
 *
 * @param aleoClient - The Aleo network client
 * @param ismAddress - The full ISM address (e.g., "ism_manager.aleo/aleo1...")
 * @returns The Test ISM configuration
 */
export async function getTestIsmConfig(
  aleoClient: AnyAleoNetworkClient,
  ismAddress: string,
): Promise<{
  type: AleoIsmType.TEST_ISM;
  address: string;
}> {
  const ismType = await getIsmType(aleoClient, ismAddress);

  assert(
    ismType === AleoIsmType.TEST_ISM,
    `Expected ism at address ${ismAddress} to be of type TEST_ISM but got ${ismType}`,
  );

  return {
    type: AleoIsmType.TEST_ISM,
    address: ismAddress,
  };
}
