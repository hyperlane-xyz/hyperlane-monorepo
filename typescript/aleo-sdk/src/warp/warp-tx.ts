import type { ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedWarpAddress,
  RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  eqAddressAleo,
  isNullish,
  isZeroishAddress,
  strip0x,
} from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import {
  ALEO_NULL_ADDRESS,
  arrayToPlaintext,
  fillArray,
  fromAleoAddress,
  programIdToPlaintext,
  stringToU128,
} from '../utils/helper.js';
import type {
  AleoTransaction,
  AnnotatedAleoTransaction,
} from '../utils/types.js';

import { getTokenMetadata } from './warp-query.js';

/**
 * Create transaction for initializing a native token
 */
export function getCreateNativeTokenTx(
  tokenProgramId: string,
): AleoTransaction {
  return {
    programName: tokenProgramId,
    functionName: 'init',
    priorityFee: 0,
    privateFee: false,
    inputs: [programIdToPlaintext(tokenProgramId), `0u8`],
  };
}

/**
 * Create transaction for initializing a collateral token
 */
export async function getCreateCollateralTokenTx(
  aleoClient: AnyAleoNetworkClient,
  tokenProgramId: string,
  collateralDenom: string,
): Promise<AleoTransaction> {
  const metadata = await getTokenMetadata(aleoClient, collateralDenom);

  return {
    programName: tokenProgramId,
    functionName: 'init',
    priorityFee: 0,
    privateFee: false,
    inputs: [
      programIdToPlaintext(tokenProgramId),
      collateralDenom,
      `${metadata.decimals}u8`,
    ],
  };
}

/**
 * Create transaction for initializing a synthetic token
 */
export function getCreateSyntheticTokenTx(
  tokenProgramId: string,
  name: string,
  denom: string,
  decimals: number,
): AleoTransaction {
  return {
    programName: tokenProgramId,
    functionName: 'init',
    priorityFee: 0,
    privateFee: false,
    inputs: [
      programIdToPlaintext(tokenProgramId),
      `${stringToU128(name).toString()}u128`,
      `${stringToU128(denom).toString()}u128`,
      `${decimals}u8`,
      `${decimals}u8`,
    ],
  };
}

/**
 * Create transaction for setting token owner
 */
export function getSetTokenOwnerTx(
  tokenAddress: string,
  newOwner: string,
): AleoTransaction {
  return {
    programName: fromAleoAddress(tokenAddress).programId,
    functionName: 'set_owner',
    priorityFee: 0,
    privateFee: false,
    inputs: [newOwner],
  };
}

/**
 * Create transaction for setting token ISM
 */
export function getSetTokenIsmTx(
  tokenAddress: string,
  ismAddress?: string,
): AleoTransaction {
  // Handle zero address - use Aleo null address to unset ISM
  const ism =
    !isNullish(ismAddress) && !isZeroishAddress(ismAddress)
      ? fromAleoAddress(ismAddress).address
      : ALEO_NULL_ADDRESS;

  return {
    programName: fromAleoAddress(tokenAddress).programId,
    functionName: 'set_custom_ism',
    priorityFee: 0,
    privateFee: false,
    inputs: [ism],
  };
}

/**
 * Create transaction for setting token hook
 */
export function getSetTokenHookTx(
  tokenAddress: string,
  hookAddress?: string,
): AleoTransaction {
  const hook =
    !isNullish(hookAddress) && !isZeroishAddress(hookAddress)
      ? fromAleoAddress(hookAddress).address
      : ALEO_NULL_ADDRESS;

  return {
    programName: fromAleoAddress(tokenAddress).programId,
    functionName: 'set_custom_hook',
    priorityFee: 0,
    privateFee: false,
    inputs: [hook],
  };
}

/**
 * Create transaction for enrolling a remote router
 */
export function getEnrollRemoteRouterTx(
  tokenAddress: string,
  domainId: number,
  routerAddress: string,
  gas: string,
): AleoTransaction {
  const bytes = fillArray(
    [...Buffer.from(strip0x(routerAddress), 'hex')].map((b) => `${b}u8`),
    32,
    `0u8`,
  );

  return {
    programName: fromAleoAddress(tokenAddress).programId,
    functionName: 'enroll_remote_router',
    priorityFee: 0,
    privateFee: false,
    inputs: [`${domainId}u32`, arrayToPlaintext(bytes), `${gas}u128`],
  };
}

/**
 * Create transaction for unenrolling a remote router
 */
export function getUnenrollRemoteRouterTx(
  tokenAddress: string,
  domainId: number,
): AleoTransaction {
  return {
    programName: fromAleoAddress(tokenAddress).programId,
    functionName: 'unroll_remote_router',
    priorityFee: 0,
    privateFee: false,
    inputs: [`${domainId}u32`],
  };
}

/**
 * Generate post-deployment transactions for ISM setup and router enrollment.
 * Used after token deployment to configure ISM and enroll remote routers.
 *
 * @param tokenAddress The deployed token address
 * @param config The warp token configuration
 * @returns Array of transactions to execute in order
 */
export function getPostDeploymentUpdateTxs<
  TConfig extends RawWarpArtifactConfig,
>(tokenAddress: string, config: TConfig): AleoTransaction[] {
  const txs: AleoTransaction[] = [];

  // Set ISM if configured
  if (config.interchainSecurityModule) {
    const setIsmTx = getSetTokenIsmTx(
      tokenAddress,
      config.interchainSecurityModule.deployed.address,
    );

    txs.push(setIsmTx);
  }

  // Enroll remote routers
  for (const [domainIdStr, remoteRouter] of Object.entries(
    config.remoteRouters,
  )) {
    const domainId = parseInt(domainIdStr);
    const gas = config.destinationGas[domainId] || '0';

    const enrollTx = getEnrollRemoteRouterTx(
      tokenAddress,
      domainId,
      remoteRouter.address,
      gas,
    );

    txs.push(enrollTx);
  }

  // We don't transfer ownership here because after deployment the token needs to be
  // enrolled with the other tokens deployed and only the owner can do that

  return txs;
}

/**
 * Generates update transactions for a warp token by comparing current on-chain state
 * with desired configuration. Returns transactions for ISM updates, router enrollment/unenrollment,
 * and ownership transfer (always last).
 *
 * @param expectedArtifactState The desired warp token configuration with deployment address
 * @param currentArtifactState The current on-chain warp token state
 * @returns Array of transactions to execute in order
 */
export async function getWarpTokenUpdateTxs<
  TConfig extends RawWarpArtifactConfig,
>(
  expectedArtifactState: ArtifactDeployed<TConfig, DeployedWarpAddress>,
  currentArtifactState: ArtifactDeployed<TConfig, DeployedWarpAddress>,
): Promise<AnnotatedAleoTransaction[]> {
  const { config: expectedConfig, deployed } = expectedArtifactState;
  const { config: currentConfig } = currentArtifactState;
  const updateTxs: AnnotatedAleoTransaction[] = [];

  // Update ISM if changed
  const currentIsm =
    currentConfig.interchainSecurityModule?.deployed.address ??
    ALEO_NULL_ADDRESS;
  const newIsm =
    expectedConfig.interchainSecurityModule?.deployed.address ??
    ALEO_NULL_ADDRESS;

  if (!eqAddressAleo(currentIsm, newIsm)) {
    const setIsmTx = getSetTokenIsmTx(deployed.address, newIsm);
    updateTxs.push({
      annotation: 'Updating token ISM',
      ...setIsmTx,
    });
  }

  // Get current and desired remote routers
  const currentRouters = new Set(
    Object.keys(currentConfig.remoteRouters).map((k) => parseInt(k)),
  );
  const desiredRouters = new Set(
    Object.keys(expectedConfig.remoteRouters).map((k) => parseInt(k)),
  );

  // Unenroll removed routers
  for (const domainId of currentRouters) {
    if (!desiredRouters.has(domainId)) {
      const unenrollTx = getUnenrollRemoteRouterTx(deployed.address, domainId);
      updateTxs.push({
        annotation: `Unenrolling router for domain ${domainId}`,
        ...unenrollTx,
      });
    }
  }

  // Enroll or update routers
  for (const [domainIdStr, remoteRouter] of Object.entries(
    expectedConfig.remoteRouters,
  )) {
    const domainId = parseInt(domainIdStr);
    const gas = expectedConfig.destinationGas[domainId] || '0';
    const currentRouter = currentConfig.remoteRouters[domainId];
    const currentGas = currentConfig.destinationGas[domainId] || '0';

    const needsUpdate =
      !currentRouter ||
      !eqAddressAleo(currentRouter.address, remoteRouter.address) ||
      currentGas !== gas;

    if (needsUpdate) {
      const enrollTx = getEnrollRemoteRouterTx(
        deployed.address,
        domainId,
        remoteRouter.address,
        gas,
      );
      updateTxs.push({
        annotation: `Enrolling/updating router for domain ${domainId}`,
        ...enrollTx,
      });
    }
  }

  // Owner transfer must be last transaction as the current owner executes all updates
  if (!eqAddressAleo(currentConfig.owner, expectedConfig.owner)) {
    const setOwnerTx = getSetTokenOwnerTx(
      deployed.address,
      expectedConfig.owner,
    );
    updateTxs.push({
      annotation: 'Setting new token owner',
      ...setOwnerTx,
    });
  }

  return updateTxs;
}
