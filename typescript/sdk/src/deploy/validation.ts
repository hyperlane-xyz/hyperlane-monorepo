import {
  Address,
  objKeys,
  objMap,
  objMapEntries,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmERC20WarpRouteReader } from '../token/EvmERC20WarpRouteReader.js';
import {
  OwnerStatus,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';
import { ChainName } from '../types.js';

const logger = rootLogger.child({ module: 'OwnerValidation' });

/**
 * Represents validation failure for a single owner address.
 */
export interface OwnerValidationResult {
  chain: ChainName;
  address: Address;
  status: OwnerStatus;
}

/**
 * Structured error thrown when owner validation fails.
 * Contains list of invalid owners and human-readable error details.
 */
export class ValidationError extends Error {
  public readonly name = 'ValidationError';

  constructor(
    public readonly invalidOwners: OwnerValidationResult[],
    message: string,
  ) {
    super(message);
  }
}

/**
 * Validates all owner addresses in a warp deployment configuration.
 * Checks owner activity status for each chain and fails deployment if any owner is inactive.
 *
 * @throws ValidationError - When any owner is inactive/error/skipped
 */
export async function validateWarpDeployOwners(
  warpConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
): Promise<void> {
  logger.info('Starting owner validation for warp deployment');

  // Extract owners from configuration
  const ownersByChain = extractOwnersFromConfig(warpConfig);

  logger.debug('Extracted owners for validation', {
    ownersByChain: Object.fromEntries(
      objMapEntries(ownersByChain, (chain, owners) => [chain, owners.length]),
    ),
  });

  // Validate all owners in parallel per chain, sequential per owner to avoid rate limiting
  const invalidOwners: OwnerValidationResult[] = [];

  for (const [chain, owners] of Object.entries(ownersByChain)) {
    logger.debug(`Validating ${owners.length} owners for chain ${chain}`);

    for (const owner of owners) {
      const result = await validateOwnerActivity(chain, owner, multiProvider);

      // Check if status is invalid (not Active or GnosisSafe)
      if (
        result.status !== OwnerStatus.Active &&
        result.status !== OwnerStatus.GnosisSafe
      ) {
        invalidOwners.push(result);
        logger.warn('Invalid owner detected', {
          chain,
          address: owner,
          status: result.status,
        });
      }
    }
  }

  if (invalidOwners.length > 0) {
    const errorMessage = `Owner validation failed: Found ${invalidOwners.length} invalid owner(s) across ${objKeys(ownersByChain).length} chain(s). Invalid owners:\n${invalidOwners.map(
      (o) => `- Chain: ${o.chain}, Owner: ${o.address}, Status: ${o.status}`,
    )}`;

    throw new ValidationError(invalidOwners, errorMessage);
  }

  logger.info('Owner validation completed successfully');
}

/**
 * Extracts all owner addresses from warp deployment configuration.
 * Handles owner overrides and proxy admin owners.
 */
export function extractOwnersFromConfig(
  warpConfig: WarpRouteDeployConfigMailboxRequired,
): Record<ChainName, Address[]> {
  return objMap(warpConfig, (chain, config) => {
    const owners: Address[] = [];

    // 1. Primary owner - use ownerOverrides[chain] if present, otherwise config.owner
    const primaryOwner = config.ownerOverrides?.[chain] || config.owner;
    if (primaryOwner) {
      owners.push(primaryOwner);
    }

    // 2. Proxy admin owner (if proxy deployment configured)
    if (config.proxyAdmin?.owner) {
      owners.push(config.proxyAdmin.owner);
    }

    return [...new Set(owners)];
  });
}

/**
 * Validates activity status of a single owner address on specific chain.
 * Uses EvmERC20WarpRouteReader.validateOwnerAddress() for direct owner validation.
 */
export async function validateOwnerActivity(
  chain: ChainName,
  address: Address,
  multiProvider: MultiProvider,
): Promise<OwnerValidationResult> {
  const reader = new EvmERC20WarpRouteReader(multiProvider, chain);
  const statusResult = await reader.validateOwnerAddress(chain, address);

  return {
    chain,
    address,
    status: statusResult[address],
  };
}
