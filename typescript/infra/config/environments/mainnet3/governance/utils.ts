import { ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { GovernanceType } from '../../../../src/governance.js';

import { awIcasV2 } from './ica/aw2.js';
import { awIcas } from './ica/aw.js';
import { regularIcasV2 } from './ica/regular2.js';
import { regularIcas } from './ica/regular.js';
import { awSafes } from './safe/aw.js';
import { irregularSafes } from './safe/irregular.js';
import { ousdtSafes } from './safe/ousdt.js';
import { regularSafes } from './safe/regular.js';
import { awSigners, awThreshold } from './signers/aw.js';
import { irregularSigners, irregularThreshold } from './signers/irregular.js';
import { regularSigners, regularThreshold } from './signers/regular.js';
import { awTimelocks } from './timelock/aw.js';
import { regularTimelocks } from './timelock/regular.js';

export function getGovernanceTimelocks(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularTimelocks;
    case GovernanceType.AbacusWorks:
      return awTimelocks;
    case GovernanceType.Irregular:
      return {};
    case GovernanceType.OUSDT:
      return {};
    default:
      throw new Error(`Unknown governance type: ${governanceType}`);
  }
}

export function getGovernanceSafes(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularSafes;
    case GovernanceType.AbacusWorks:
      return awSafes;
    case GovernanceType.Irregular:
      return irregularSafes;
    case GovernanceType.OUSDT:
      return ousdtSafes;
    default:
      throw new Error(`Unknown governance type: ${governanceType}`);
  }
}

export function getLegacyGovernanceIcas(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularIcas;
    case GovernanceType.AbacusWorks:
      return awIcas;
    case GovernanceType.Irregular:
      return {};
    case GovernanceType.OUSDT:
      return {};
    default:
      throw new Error(`Unknown governance type: ${governanceType}`);
  }
}

export function getGovernanceIcas(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularIcasV2;
    case GovernanceType.AbacusWorks:
      return awIcasV2;
    case GovernanceType.Irregular:
      return {};
    case GovernanceType.OUSDT:
      return {};
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
    case GovernanceType.Irregular:
      return {
        signers: irregularSigners,
        threshold: irregularThreshold,
      };
    default:
      throw new Error(
        `Unsupported method for governance type: ${governanceType}`,
      );
  }
}

export function getSafeChains(): Set<ChainName> {
  return new Set(
    ...Object.keys(getGovernanceSafes(GovernanceType.AbacusWorks)),
    ...Object.keys(getGovernanceSafes(GovernanceType.Regular)),
    ...Object.keys(getGovernanceSafes(GovernanceType.Irregular)),
    ...Object.keys(getGovernanceSafes(GovernanceType.OUSDT)),
  );
}

export function getAllSafesForChain(chain: ChainName): string[] {
  return Object.values(GovernanceType)
    .map((governanceType) => getGovernanceSafes(governanceType)[chain])
    .filter((safe) => safe !== undefined);
}
