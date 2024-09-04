import yargs from 'yargs';

import { Contexts } from '../../config/contexts.js';
import { safes } from '../../config/environments/mainnet3/owners.js';
import { Role } from '../../src/roles.js';
import { deleteAllPendingSafeTxs } from '../../src/utils/safe.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { chains } = await withChains(yargs(process.argv.slice(2))).argv;

  if (!chains || chains.length === 0) {
    console.error('No chains provided');
    process.exit(1);
  }

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    chains,
  );

  for (const chain of chains) {
    try {
      await deleteAllPendingSafeTxs(chain, multiProvider, safes[chain]);
    } catch (error) {
      console.error(`Error deleting pending transactions for ${chain}:`, error);
    }
  }
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
