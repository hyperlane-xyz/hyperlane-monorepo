import { ChainName } from '@hyperlane-xyz/sdk';

import { GovernanceType } from '../../../../src/governance.js';

import { awIcas } from './ica/aw.js';
import { regularIcas } from './ica/regular.js';
import { awSafes } from './safe/aw.js';
import { regularSafes } from './safe/regular.js';

export function getGovernanceSafes(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularSafes;
    case GovernanceType.AbacusWorks:
      return awSafes;
    default:
      throw new Error(`Unknown governance type: ${governanceType}`);
  }
}

export function getGovernanceIcas(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularIcas;
    case GovernanceType.AbacusWorks:
      return awIcas;
    default:
      throw new Error(`Unknown governance type: ${governanceType}`);
  }
}

export function getSafeChains(): Set<ChainName> {
  return new Set(
    ...Object.keys(getGovernanceSafes(GovernanceType.AbacusWorks)),
    ...Object.keys(getGovernanceSafes(GovernanceType.Regular)),
  );
}
