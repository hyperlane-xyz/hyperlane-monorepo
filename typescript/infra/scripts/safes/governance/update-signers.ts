import Safe from '@safe-global/protocol-kit';
import yargs from 'yargs';

import { ChainName } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import {
  getGovernanceSafes,
  getGovernanceSigners,
} from '../../../config/environments/mainnet3/governance/utils.js';
import { AnnotatedCallData } from '../../../src/govern/HyperlaneAppGovernor.js';
import { SafeMultiSend } from '../../../src/govern/multisend.js';
import { GovernanceType, withGovernanceType } from '../../../src/governance.js';
import { Role } from '../../../src/roles.js';
import {
  getOwnerChanges,
  getSafeAndService,
  updateSafeOwner,
} from '../../../src/utils/safe.js';
import { withChainsRequired, withPropose } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

async function main() {
  const {
    propose,
    governanceType = GovernanceType.Regular,
    chains,
  } = await withChainsRequired(
    withGovernanceType(withPropose(yargs(process.argv.slice(2)))),
  ).argv;

  const { signers, threshold } = getGovernanceSigners(governanceType);
  const safes = getGovernanceSafes(governanceType);

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    Object.keys(safes),
  );

  for (const chain of chains) {
    const safeAddress = safes[chain];
    if (!safeAddress) {
      rootLogger.error(`[${chain}] safe not found`);
      continue;
    }

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

    let safeMultiSend: SafeMultiSend;
    try {
      safeMultiSend = await SafeMultiSend.initialize(
        multiProvider,
        chain as ChainName,
        safeAddress,
      );
    } catch (error) {
      rootLogger.error(`[${chain}] could not get safe multi send: ${error}`);
      continue;
    }

    // Check if owner changes are valid (1-to-1 swaps only)
    const currentOwners = await safeSdk.getOwners();
    const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
      currentOwners,
      signers,
    );

    if (ownersToRemove.length !== ownersToAdd.length) {
      rootLogger.error(
        `[${chain}] Asymmetric owner changes are not supported. ` +
          `This script only supports 1-to-1 owner swaps. ` +
          `Got ${ownersToRemove.length} removes and ${ownersToAdd.length} adds. ` +
          `Please ensure the number of signers remains constant.`,
      );
      continue;
    }

    let transactions: AnnotatedCallData[];
    try {
      transactions = await updateSafeOwner({
        safeSdk,
        owners: signers,
        threshold,
      });
    } catch (error) {
      rootLogger.error(`[${chain}] could not update safe owner: ${error}`);
      continue;
    }

    rootLogger.info(`[${chain}] Generated transactions for updating signers`);
    rootLogger.info(`[${chain}] ${JSON.stringify(transactions, null, 2)}`);

    if (propose) {
      try {
        await safeMultiSend.sendTransactions(
          transactions.map((call) => ({
            to: call.to,
            data: call.data,
            value: call.value,
          })),
        );
        rootLogger.info(`[${chain}] Successfully sent transactions`);
      } catch (error) {
        rootLogger.error(`[${chain}] could not send transactions: ${error}`);
      }
    }
  }

  if (!propose) {
    rootLogger.info('Skipping sending transactions, pass --propose to send');
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
