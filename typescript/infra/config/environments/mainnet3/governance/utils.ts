import { ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { GovernanceType } from '../../../../src/governance.js';

import { awIcasLegacy } from './ica/_awLegacy.js';
import { regularIcasLegacy } from './ica/_regularLegacy.js';
import { awIcas } from './ica/aw.js';
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
import { dymensionTimelocks } from './timelock/dymension.js';
import { dymensionSafes } from './safe/dymension.js';
import { dymensionIcas } from './ica/dymension.js';
import { dymensionSigners, dymensionThreshold } from './signers/dymension.js';


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
    case GovernanceType.Dymension:
      return dymensionTimelocks;
    default:
      throw new Error(`Unsupported governance type: ${governanceType}`);
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
    case GovernanceType.Dymension:
      return dymensionSafes;
    default:
      throw new Error(`Unsupported governance type: ${governanceType}`);
  }
}

export function getLegacyGovernanceIcas(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularIcasLegacy;
    case GovernanceType.AbacusWorks:
      return awIcasLegacy;
    case GovernanceType.Irregular:
      return {};
    case GovernanceType.OUSDT:
      return {};
    case GovernanceType.Dymension:
      return {};
    default:
      throw new Error(`Unsupported governance type: ${governanceType}`);
  }
}

export function getGovernanceIcas(governanceType: GovernanceType) {
  switch (governanceType) {
    case GovernanceType.Regular:
      return regularIcas;
    case GovernanceType.AbacusWorks:
      return awIcas;
    case GovernanceType.Irregular:
      return {};
    case GovernanceType.OUSDT:
      return {};
    case GovernanceType.Dymension:
      return dymensionIcas;
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
    case GovernanceType.Dymension:
      return {
        signers: dymensionSigners,
        threshold: dymensionThreshold,
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
    ...Object.keys(getGovernanceSafes(GovernanceType.Dymension)),
  );
}

export function getAllSafesForChain(chain: ChainName): string[] {
  return Object.values(GovernanceType)
    .map((governanceType) => getGovernanceSafes(governanceType)[chain])
    .filter((safe) => safe !== undefined);
}
