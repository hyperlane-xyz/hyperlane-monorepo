import { ChainName } from '@hyperlane-xyz/sdk';

import { GovernanceType } from '../../../../src/governance.js';

import { awIcas } from './ica/aw.js';
import { exceptionalIcas } from './ica/exceptional.js';
import { irregularIcas } from './ica/irregular.js';
import { regularIcas } from './ica/regular.js';
import { awSafes } from './safe/aw.js';
import { exceptionalSafes } from './safe/exceptional.js';
import { irregularSafes } from './safe/irregular.js';
import { regularSafes } from './safe/regular.js';

export function getGovernanceSafes(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularSafes;
    case GovernanceType.Irregular:
      return irregularSafes;
    case GovernanceType.Exceptional:
      return exceptionalSafes;
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
    case GovernanceType.Irregular:
      return irregularIcas;
    case GovernanceType.Exceptional:
      return exceptionalIcas;
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
    ...Object.keys(getGovernanceSafes(GovernanceType.Irregular)),
    ...Object.keys(getGovernanceSafes(GovernanceType.Exceptional)),
  );
}
