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
import { getSafeAndService, updateSafeOwner } from '../../../src/utils/safe.js';
import { withPropose } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

async function main() {
  const { propose, governanceType = GovernanceType.Regular } =
    await withGovernanceType(withPropose(yargs(process.argv.slice(2)))).argv;

  const { signers, threshold } = getGovernanceSigners(governanceType);
  const safes = getGovernanceSafes(governanceType);

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
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

    let safeMultiSend: SafeMultiSend;
    try {
      safeMultiSend = new SafeMultiSend(
        multiProvider,
        chain as ChainName,
        safeAddress,
      );
    } catch (error) {
      rootLogger.error(`[${chain}] could not get safe multi send: ${error}`);
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
