import { compareVersions } from 'compare-versions';
import { providers } from 'ethers';

import { Address, chunk, isNullish, strip0x } from '@hyperlane-xyz/utils';

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
  if (data === '0x') return true;

  // Some ethers/provider combinations only expose empty return data in the
  // formatted message.
  return (
    typeof callException.message === 'string' &&
    callException.message.includes('data="0x"')
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
