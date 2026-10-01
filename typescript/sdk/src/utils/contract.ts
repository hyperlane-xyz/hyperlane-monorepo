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

// Diamond fallbacks can use this custom error instead of empty revert data
// when no facet implements the requested selector. The value is the selector of
// FacetNotFound() (first 4 bytes of keccak256("FacetNotFound()")), which takes no
// arguments, so the revert data is exactly the selector.
const FACET_NOT_FOUND_REVERT_DATA = '0x800ab12c';

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
// Nethermind (before it adopted code 3) reports every VM failure as -32015
// "VM execution error." and names the failure in the string `data`
// ("revert", "err: revert (supplied gas N)", "err: OutOfGas ...").
const NETHERMIND_VM_EXECUTION_ERROR_JSON_RPC_CODE = -32015;
const NODE_REVERT_MESSAGE_PATTERN = /\brevert(ed)?\b/i;

/**
 * True for EVM call return/revert data with no payload ('0x' or ''). Not
 * isStorageEmpty, which also accepts '0x0' as an empty storage slot.
 */
export function isReturnDataEmpty(data: unknown): boolean {
  return data === '0x' || data === '';
}

function nestedErrorReportsRevert(callException: unknown): boolean {
  const { code, message, data } = getNestedJsonRpcError(callException);
  return (
    code === EXECUTION_REVERTED_JSON_RPC_CODE ||
    (typeof message === 'string' &&
      NODE_REVERT_MESSAGE_PATTERN.test(message)) ||
    (code === NETHERMIND_VM_EXECUTION_ERROR_JSON_RPC_CODE &&
      typeof data === 'string' &&
      NODE_REVERT_MESSAGE_PATTERN.test(data))
  );
}

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
 * the message fallback (for ethers/provider combinations that only expose
 * empty return data there) applies only when there is no nested error. With a
 * nested error, the call counts as a missing selector when the nested error
 * reports a revert (JSON-RPC code 3, a revert message, or Nethermind's -32015
 * with revert data), or when it reports empty data ("0x" or "") and carries
 * neither a code nor a message. A nested error that pairs empty data with any
 * other code (SERVER_ERROR, 429, -32000 "header not found") or with a
 * non-revert message ("socket hang up", "timeout") is a transport failure.
 * Failures that are not reverts (out of gas, invalid opcode) are not missing
 * selectors.
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
  // A diamond miss is a known "no such function" revert, so unlike empty data
  // it needs no transport gating.
  if (
    typeof data === 'string' &&
    data.toLowerCase() === FACET_NOT_FOUND_REVERT_DATA
  ) {
    return true;
  }

  const {
    code: nestedCode,
    message: nestedMessage,
    data: nestedData,
  } = getNestedJsonRpcError(callException);
  if (isReturnDataEmpty(nestedData)) {
    return (
      nestedErrorReportsRevert(callException) ||
      (isNullish(nestedCode) && isNullish(nestedMessage))
    );
  }

  // Some ethers/provider combinations only expose empty return data in the
  // formatted message.
  const hasEmptyData =
    isReturnDataEmpty(data) ||
    (typeof callException.message === 'string' &&
      callException.message.includes('data="0x"'));
  if (!hasEmptyData) return false;

  if (isNullish(callException.error)) return true;

  return nestedErrorReportsRevert(callException);
}

const REVERT_DATA_PATTERN = /^0x[0-9a-fA-F]+$/;
// Panic(uint256)
const PANIC_SELECTOR = '0x4e487b71';

/**
 * True for a CALL_EXCEPTION whose revert data is a Panic(uint256). Unlike
 * isMissingSelectorRevert, it treats the reverting probe as an answer rather
 * than a failure to reach the contract.
 */
export function isPanicRevert(error: unknown): boolean {
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
    REVERT_DATA_PATTERN.test(data) &&
    data.toLowerCase().startsWith(PANIC_SELECTOR)
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
