import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getGovernanceTimelocks } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import { Role } from '../../src/roles.js';
import { deleteTimelockTx } from '../../src/utils/timelock.js';
import { withChain } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { chain, tx, governanceType } = await withGovernanceType(
    withChain(
      yargs(process.argv.slice(2)).option('tx', {
        type: 'string',
        description: 'Transaction hash to delete',
        demandOption: true,
      }),
    ),
  ).argv;

  if (!chain) {
    rootLogger.error('No chain provided');
    process.exit(1);
  }

  if (!tx) {
    rootLogger.error('No transaction hash provided');
    process.exit(1);
  }

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    [chain],
  );

  const timelocks = getGovernanceTimelocks(governanceType);

  const currentChainTimelock = timelocks[chain];
  if (!currentChainTimelock) {
    rootLogger.error(`No timelock contract found for chain ${chain}`);
    process.exit(1);
  }

  try {
    await deleteTimelockTx(chain, currentChainTimelock, tx, multiProvider);
  } catch (error) {
    rootLogger.error(
      `Error deleting timelock operation "${tx}" for "${chain}":`,
      error,
    );
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
