import yargs from 'yargs';

import { deleteAllPendingSafeTxs } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import { Role } from '../../src/roles.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { chains, governanceType } = await withGovernanceType(
    withChains(yargs(process.argv.slice(2))),
  ).argv;

  if (!chains || chains.length === 0) {
    rootLogger.error('No chains provided');
    process.exit(1);
  }

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    chains,
  );

  const safes = getGovernanceSafes(governanceType);

  for (const chain of chains) {
    const safeAddress = safes[chain];
    if (!safeAddress) {
      rootLogger.error(`No safe configured for ${chain}, skipping`);
      continue;
    }
    try {
      await deleteAllPendingSafeTxs(chain, multiProvider, safeAddress);
    } catch (error) {
      rootLogger.error(
        `Error deleting pending transactions for ${chain}:`,
        error,
      );
    }
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
