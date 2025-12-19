import { assert, ensure0x, isZeroishAddress } from '@hyperlane-xyz/utils';

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

function formatIsmMultisigInfo(raw: unknown): {
  validators: string[];
  threshold: number;
} {
  assert(
    typeof raw === 'object' && raw !== null,
    `Expected multisig config to be an object but got ${typeof raw}`,
  );

  const { validators, threshold } = raw as any;

  assert(
    Array.isArray(validators),
    'Expected validators array in multisig config',
  );

  assert(
    typeof threshold === 'number',
    'Expected threshold number in multisig config',
  );

  return {
    // The multisig ISM on Aleo can have a max
    // of 6 validators. If there are less than 6,
    // the remaining items in the array will be 0
    // addresses
    validators: validators
      .map((v) => {
        assert(
          Array.isArray(v.bytes),
          'Expected validator bytes to be an array',
        );
        return ensure0x(Buffer.from(v.bytes).toString('hex'));
      })
      // Remove any unset validator from the result array
      .filter((validatorAddress) => !isZeroishAddress(validatorAddress)),
    threshold,
  };
}

/**
 * Query the configuration for a Multisig ISM (Message ID or Merkle Root).
 *
 * @param aleoClient - The Aleo network client
 * @param ismAddress - The full ISM address (e.g., "ism_manager.aleo/aleo1...")
 * @returns The Multisig ISM configuration
 */
export async function getMessageIdMultisigIsmConfig(
  aleoClient: AnyAleoNetworkClient,
  ismAddress: string,
): Promise<{
  address: string;
  type: AleoIsmType.MESSAGE_ID_MULTISIG;
  threshold: number;
  validators: string[];
}> {
  const { address, programId } = fromAleoAddress(ismAddress);
  const ismType = await getIsmType(aleoClient, ismAddress);

  assert(
    ismType === AleoIsmType.MESSAGE_ID_MULTISIG,
    `Expected ism at address ${ismAddress} to be a multisig ISM but got ${ismType}`,
  );

  const { threshold, validators } = await queryMappingValue(
    aleoClient,
    programId,
    'message_id_multisigs',
    address,
    formatIsmMultisigInfo,
  );

  return {
    address: ismAddress,
    type: ismType,
    validators,
    threshold,
  };
}
