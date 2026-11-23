import { Domain, assert } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

/**
 * The reader keys enrolled domains outside the registry by their numeric
 * domain ID, so those keys are used as the domain directly.
 */
export function resolveRemoteDomainId(
  multiProvider: MultiProvider,
  remote: string,
  chain: ChainName,
): Domain {
  const knownDomainId = multiProvider.tryGetDomainId(remote);
  if (knownDomainId !== null) return knownDomainId;

  const domainId = Number(remote);
  assert(
    Number.isSafeInteger(domainId) && domainId >= 0,
    `Cannot resolve domain for remote ${remote} on ${chain}`,
  );
  return domainId;
}
