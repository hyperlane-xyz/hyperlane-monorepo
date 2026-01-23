import { strip0x } from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import {
  arrayToPlaintext,
  fillArray,
  fromAleoAddress,
  programIdToPlaintext,
} from '../utils/helper.js';
import type { AleoTransaction } from '../utils/types.js';

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
  ismAddress: string,
): AleoTransaction {
  return {
    programName: fromAleoAddress(tokenAddress).programId,
    functionName: 'set_custom_ism',
    priorityFee: 0,
    privateFee: false,
    inputs: [fromAleoAddress(ismAddress).address],
  };
}

/**
 * Create transaction for setting token hook
 */
export function getSetTokenHookTx(
  tokenAddress: string,
  hookAddress: string,
): AleoTransaction {
  return {
    programName: fromAleoAddress(tokenAddress).programId,
    functionName: 'set_custom_hook',
    priorityFee: 0,
    privateFee: false,
    inputs: [fromAleoAddress(hookAddress).address],
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
