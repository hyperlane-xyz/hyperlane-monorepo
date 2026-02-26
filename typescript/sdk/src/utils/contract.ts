import { compareVersions } from 'compare-versions';
import { providers } from 'ethers';

import { Address, chunk, strip0x } from '@hyperlane-xyz/utils';

export function isValidContractVersion(
  currentVersion: string,
  targetVersion: string,
): boolean {
  return compareVersions(currentVersion, targetVersion) >= 0;
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
