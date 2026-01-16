import {
  assert,
  ensure0x,
  isNullish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import {
  queryMappingValue,
  tryQueryMappingValue,
} from '../utils/base-query.js';
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
    typeof raw === 'object' && !isNullish(raw),
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

function formatRoutingIsmData(raw: unknown): { owner: string } {
  assert(
    typeof raw === 'object' && !isNullish(raw),
    `Expected routing ISM data to be an object but got ${typeof raw}`,
  );

  const { ism_owner } = raw as any;

  assert(
    typeof ism_owner === 'string',
    'Expected ism_owner to be a string in routing ISM data',
  );

  return { owner: ism_owner };
}

function formatRouteLength(raw: unknown): number {
  assert(
    typeof raw === 'number',
    `Expected route length to be a number but got ${typeof raw}`,
  );
  return raw;
}

function formatRouteIsmAddress(raw: unknown): string {
  assert(
    typeof raw === 'string',
    `Expected route ISM address to be a string but got ${typeof raw}`,
  );
  return raw;
}

/**
 * Query the configuration for a Routing ISM.
 *
 * @param aleoClient - The Aleo network client
 * @param ismAddress - The full ISM address (e.g., "ism_manager.aleo/aleo1...")
 * @returns The Routing ISM configuration
 */
export async function getRoutingIsmConfig(
  aleoClient: AnyAleoNetworkClient,
  ismAddress: string,
): Promise<{
  type: AleoIsmType.ROUTING;
  address: string;
  owner: string;
  routes: {
    domainId: number;
    ismAddress: string;
  }[];
}> {
  const { address, programId } = fromAleoAddress(ismAddress);
  const ismType = await getIsmType(aleoClient, ismAddress);

  assert(
    ismType === AleoIsmType.ROUTING,
    `Expected ism at address ${ismAddress} to be of type ROUTING but got ${ismType}`,
  );

  const routes: { domainId: number; ismAddress: string }[] = [];

  const ismData = await queryMappingValue(
    aleoClient,
    programId,
    'domain_routing_isms',
    address,
    formatRoutingIsmData,
  );

  const routeLengthRes = await queryMappingValue(
    aleoClient,
    programId,
    'route_length',
    address,
    formatRouteLength,
  );

  for (let i = 0; i < routeLengthRes; i++) {
    let routeKey;
    try {
      routeKey = await aleoClient.getProgramMappingPlaintext(
        programId,
        'route_iter',
        `{ism:${address},index:${i}u32}`,
      );
    } catch (err) {
      throw new Error(
        `Failed to query route_iter for ISM ${ismAddress} at index ${i}: ${err}`,
      );
    }

    const routeIsmAddress = await tryQueryMappingValue(
      aleoClient,
      programId,
      'routes',
      routeKey.toString(),
      formatRouteIsmAddress,
    );

    // This is necessary because `route_iter` maintains keys for all route entries,
    // including those from domains that have already been removed. When a domain is
    // deleted from the Routing ISM, its key remains in the map and `routes` simply returns null.
    if (!routeIsmAddress) continue;

    const routeKeyObj = routeKey.toObject();

    // Skip routes with invalid domain data. This could happen if the on-chain
    // structure changes. Rather than failing the entire
    // ISM read, we skip invalid entries to allow partial recovery.
    // TODO: Add proper logging when aleo-sdk has a logging framework
    if (
      typeof routeKeyObj.domain !== 'number' &&
      typeof routeKeyObj.domain !== 'string'
    ) {
      continue;
    }

    const domainId = Number(routeKeyObj.domain);
    if (isNaN(domainId)) {
      continue;
    }

    routes.push({
      ismAddress: `${programId}/${routeIsmAddress}`,
      domainId,
    });
  }

  return {
    type: AleoIsmType.ROUTING,
    address: ismAddress,
    owner: ismData.owner,
    routes: routes,
  };
}
