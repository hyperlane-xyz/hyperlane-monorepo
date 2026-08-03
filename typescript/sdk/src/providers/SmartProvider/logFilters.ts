import { providers } from 'ethers';

import {
  assert,
  isNullish,
  isValidAddressEvm,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { ProviderMethod } from './ProviderMethods.js';
import { HyperlaneLogFilter } from './types.js';

type MultiAddressLogFilter = Extract<
  HyperlaneLogFilter,
  { address: readonly string[] }
>;

export function isMultiAddressFilter(
  filter: HyperlaneLogFilter,
): filter is MultiAddressLogFilter {
  return Array.isArray(filter.address);
}

export function normalizeMultiAddress(addresses: readonly unknown[]): string[] {
  assert(
    addresses.length > 0,
    'Multi-address log filters require at least one address',
  );

  const normalizedAddresses = addresses.map((address) => {
    assert(
      typeof address === 'string',
      'Multi-address log filters require valid addresses',
    );
    const normalizedAddress = normalizeAddressEvm(address);
    assert(isValidAddressEvm(normalizedAddress), 'invalid address');
    return normalizedAddress;
  });
  return [...new Set(normalizedAddresses)];
}

export async function getMultiAddressLogs(
  provider: providers.BaseProvider,
  filter: MultiAddressLogFilter,
): Promise<providers.Log[]> {
  await provider.getNetwork();
  const { address, ...filterWithoutAddress } = filter;
  const normalizedFilter = await provider._getFilter(filterWithoutAddress);
  const normalizedAddresses = normalizeMultiAddress(address);
  const logs: providers.Log[] = await provider.perform(ProviderMethod.GetLogs, {
    filter: { ...normalizedFilter, address: normalizedAddresses },
  });

  for (const log of logs) {
    if (isNullish(log.removed)) log.removed = false;
  }
  return providers.Formatter.arrayOf(
    provider.formatter.filterLog.bind(provider.formatter),
  )(logs);
}
