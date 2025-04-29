import Safe from '@safe-global/protocol-kit';
import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import {
  getGovernanceSafes,
  getGovernanceSigners,
} from '../../../config/environments/mainnet3/governance/utils.js';
import { GovernanceType, withGovernanceType } from '../../../src/governance.js';
import { Role } from '../../../src/roles.js';
import { getOwnerChanges, getSafeAndService } from '../../../src/utils/safe.js';
import { getEnvironmentConfig } from '../../core-utils.js';

enum SafeConfigViolationType {
  missingOwners = 'missingOwners',
  unexpectedOwners = 'unexpectedOwners',
  thresholdMismatch = 'thresholdMismatch',
}

interface SafeConfigViolation {
  type: SafeConfigViolationType;
  chain: string;
  safeAddress: string;
  owners?: string[];
  expected?: string;
  actual?: string;
}

async function main() {
  const { governanceType = GovernanceType.Regular } = await withGovernanceType(
    yargs(process.argv.slice(2)),
  ).argv;

  const violations: SafeConfigViolation[] = [];

  const { signers, threshold } = getGovernanceSigners(governanceType);
  const safes = getGovernanceSafes(governanceType);

  const multiProvider = await getEnvironmentConfig('mainnet3').getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    Object.keys(safes),
  );

  for (const [chain, safeAddress] of Object.entries(safes)) {
    let safeSdk: Safe.default;
    try {
      ({ safeSdk } = await getSafeAndService(
        chain,
        multiProvider,
        safeAddress,
      ));
    } catch (error) {
      rootLogger.error(`[${chain}] could not get safe: ${error}`);
      continue;
    }

    const currentOwners = await safeSdk.getOwners();
    const currentThreshold = await safeSdk.getThreshold();
    const expectedOwners = signers;
    const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
      currentOwners,
      expectedOwners,
    );

    if (ownersToRemove.length > 0) {
      violations.push({
        type: SafeConfigViolationType.unexpectedOwners,
        chain,
        safeAddress,
        owners: ownersToRemove,
      });
    }

    if (ownersToAdd.length > 0) {
      violations.push({
        type: SafeConfigViolationType.missingOwners,
        chain,
        safeAddress,
        owners: ownersToAdd,
      });
    }

    if (threshold !== currentThreshold) {
      violations.push({
        type: SafeConfigViolationType.thresholdMismatch,
        chain,
        safeAddress,
        expected: threshold.toString(),
        actual: currentThreshold.toString(),
      });
    }
  }

  if (violations.length > 0) {
    // Display threshold mismatches in a table
    const thresholdViolations = violations.filter(
      (v) => v.type === SafeConfigViolationType.thresholdMismatch,
    );
    if (thresholdViolations.length > 0) {
      console.table(thresholdViolations, [
        'chain',
        'safeAddress',
        'expected',
        'actual',
      ]);
    }

    // Group other violations by chain
    const violationsByChain = violations
      .filter((v) => v.type !== SafeConfigViolationType.thresholdMismatch)
      .reduce((acc, v) => {
        if (!acc[v.chain]) acc[v.chain] = [];
        acc[v.chain].push(v);
        return acc;
      }, {} as Record<string, SafeConfigViolation[]>);

    // Display chain-specific violations as bulleted lists
    for (const [chain, chainViolations] of Object.entries(violationsByChain)) {
      rootLogger.info(`\nChain: ${chain}`);

      const missingSigs = chainViolations.find(
        (v) => v.type === SafeConfigViolationType.missingOwners,
      );
      if (missingSigs?.owners?.length) {
        rootLogger.info('Missing signers:');
        missingSigs.owners.forEach((owner) => rootLogger.info(`  • ${owner}`));
      }

      const extraSigs = chainViolations.find(
        (v) => v.type === SafeConfigViolationType.unexpectedOwners,
      );
      if (extraSigs?.owners?.length) {
        rootLogger.info('Extraneous signers:');
        extraSigs.owners.forEach((owner) => rootLogger.info(`  • ${owner}`));
      }
    }
  } else {
    rootLogger.info('No violations found');
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
