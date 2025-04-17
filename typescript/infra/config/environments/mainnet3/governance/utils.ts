import { ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { GovernanceType } from '../../../../src/governance.js';

import { awIcas } from './ica/aw.js';
import { regularIcas } from './ica/regular.js';
import { awSafes } from './safe/aw.js';
import { regularSafes } from './safe/regular.js';
import { awSigners, awThreshold } from './signers/aw.js';
import { regularSigners, regularThreshold } from './signers/regular.js';

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

export function getGovernanceSigners(governanceType: GovernanceType): {
  signers: Address[];
  threshold: number;
} {
  switch (governanceType) {
    case GovernanceType.Regular:
      return {
        signers: regularSigners,
        threshold: regularThreshold,
      };
    case GovernanceType.AbacusWorks:
      return {
        signers: awSigners,
        threshold: awThreshold,
      };
  }
}
export function getSafeChains(): Set<ChainName> {
  return new Set(
    ...Object.keys(getGovernanceSafes(GovernanceType.AbacusWorks)),
    ...Object.keys(getGovernanceSafes(GovernanceType.Regular)),
  );
}
