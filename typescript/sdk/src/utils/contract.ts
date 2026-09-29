import { compareVersions } from 'compare-versions';
import { providers } from 'ethers';

import { PackageVersioned__factory } from '@hyperlane-xyz/core';
import {
  Address,
  Logger,
  chunk,
  isNullish,
  rootLogger,
  strip0x,
} from '@hyperlane-xyz/utils';

import { getNestedJsonRpcError } from '../providers/SmartProvider/jsonRpcError.js';

/**
 * Returns true when the deployed contract version is already at or above the
 * target version.
 */
export function isValidContractVersion(
  currentVersion: string,
  targetVersion: string,
): boolean {
  return compareVersions(currentVersion, targetVersion) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && !isNullish(value);
}

function getErrorMessage(error: unknown): string | undefined {
  return error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === 'string'
      ? error.message
      : undefined;
}

function isEmptyProviderResponse(error: unknown): boolean {
  let current = error;
  while (isRecord(current)) {
    // Assumes the originating provider call was an eth_call probe. The
    // HyperlaneJsonRpcProvider also emits this message for empty getBalance,
    // getBlock, and getBlockNumber responses.
    if (getErrorMessage(current) === 'Invalid response from provider') {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function findCallException(
  error: unknown,
): Record<string, unknown> | undefined {
  let current = error;
  while (isRecord(current)) {
    if (current.code === 'CALL_EXCEPTION') return current;
    current = current.cause;
  }
  return undefined;
}

export function isMissingSelectorCallException(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (isEmptyProviderResponse(error)) return true;

  return isMissingSelectorRevert(error);
}

// EIP-1474 execution error
const EXECUTION_REVERTED_JSON_RPC_CODE = 3;
const NODE_REVERT_MESSAGE_PATTERN = /\brevert(ed)?\b/i;

/**
 * True for an ethers CALL_EXCEPTION produced by a call that executed and
 * returned nothing: either ethers failed to decode an empty return (no nested
 * error) or the node reported an execution revert without data.
 *
 * ethers wraps every eth_call failure without revert data as a CALL_EXCEPTION
 * with data "0x", including transport failures (HTTP status errors, dropped
 * connections, JSON-RPC errors such as "header not found"). Those carry the
 * original error nested and must not be read as a missing selector. The
 * formatted message also contains data="0x" for those wrapped failures, so
 * neither the data field nor the message text alone can tell a missing
 * selector from an outage; the nested error has to be inspected.
 */
export function isMissingSelectorRevert(error: unknown): boolean {
  const callException = findCallException(error);
  if (!callException) return false;

  const nestedError = isRecord(callException.error)
    ? callException.error
    : undefined;
  const data =
    typeof callException.data === 'string'
      ? callException.data
      : nestedError?.data;
  if (data !== '0x') return false;

  if (isNullish(callException.error)) return true;

  const { code, message } = getNestedJsonRpcError(callException);
  return (
    code === EXECUTION_REVERTED_JSON_RPC_CODE ||
    (typeof message === 'string' && NODE_REVERT_MESSAGE_PATTERN.test(message))
  );
}

const REVERT_DATA_PATTERN = /^0x[0-9a-fA-F]+$/;
// 0x + 4-byte selector
const MIN_REVERT_DATA_LENGTH = 10;

/**
 * True for any contract revert carrying selector-prefixed data (custom error,
 * Error(string), Panic). Unlike isMissingSelectorRevert, it treats a reverting
 * probe as an answer rather than a failure to reach the contract.
 */
export function isRevertWithData(error: unknown): boolean {
  const callException = findCallException(error);
  if (!callException) return false;

  const nestedError = isRecord(callException.error)
    ? callException.error
    : undefined;
  const data =
    typeof callException.data === 'string'
      ? callException.data
      : nestedError?.data;

  return (
    typeof data === 'string' &&
    data.length >= MIN_REVERT_DATA_LENGTH &&
    REVERT_DATA_PATTERN.test(data)
  );
}

export function throwIfNotMissingSelector(error: unknown): void {
  if (!isMissingSelectorCallException(error)) throw error;
}

export function throwIfNotMissingSelectorRevert(error: unknown): void {
  if (!isMissingSelectorRevert(error)) throw error;
}

export async function contractHasString(
  provider: providers.Provider,
  address: Address,
  searchFor: string,
): Promise<boolean> {
  const code = await provider.getCode(address);
  const hexString = strip0x(Buffer.from(searchFor).toString('hex'));
  // largest stack operation is PUSH32 https://www.evm.codes/?fork=osaka#7f
  const chunks = chunk(hexString, 32 * 2);
  for (const chunk of chunks) {
    if (!code.includes(chunk)) {
      return false;
    }
  }
  return true;
}

/**
 * Version reported for contracts that predate PACKAGE_VERSION (introduced in
 * @hyperlane-xyz/core@5.4.0); such a contract reverts the call with empty
 * return data (missing selector).
 * https://github.com/hyperlane-xyz/hyperlane-monorepo/releases/tag/%40hyperlane-xyz%2Fcore%405.4.0
 */
export const LEGACY_PACKAGE_VERSION = '5.3.9';

/**
 * Reads a contract's PACKAGE_VERSION(), returning LEGACY_PACKAGE_VERSION for
 * pre-5.4.0 contracts (missing selector). Real RPC/provider errors propagate.
 */
export async function fetchPackageVersion(
  provider: providers.Provider,
  address: Address,
  logger: Logger = rootLogger,
): Promise<string> {
  try {
    return await PackageVersioned__factory.connect(
      address,
      provider,
    ).PACKAGE_VERSION();
  } catch (error) {
    if (isMissingSelectorCallException(error)) return LEGACY_PACKAGE_VERSION;
    logger.error(`Error fetching package version for ${address}:`, error);
    throw error;
  }
}
