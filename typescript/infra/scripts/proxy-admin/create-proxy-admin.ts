import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { assert, mapAllSettled, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { chainsToSkip } from '../../src/config/chain.js';
import {
  GovernanceType,
  Owner,
  resolveGovernanceOwner,
  withGovernanceType,
} from '../../src/governance.js';
import { Role } from '../../src/roles.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChainsRequired } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({ module: 'deploy-proxy-admin' });

async function main() {
  const argv = await withGovernanceType(withChainsRequired(getArgs())).option(
    'ownerType',
    {
      type: 'string',
      description: 'Which governance address resolver to use for ownership',
      choices: Object.values(Owner),
      demandOption: true,
    },
  ).argv;

  const { environment, governanceType, ownerType, chains } = argv;

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
  );

  const targetChains = chains.filter(
    (chain) => isEthereumProtocolChain(chain) && !chainsToSkip.includes(chain),
  );
  const excludedChains = chains.filter((c) => !targetChains.includes(c));
  if (excludedChains.length) {
    logger.warn(`Excluded chains: ${excludedChains.join(', ')}`);
  }
  assert(
    targetChains.length > 0,
    'No eligible EVM chains after filtering --chains',
  );

  const { fulfilled, rejected } = await mapAllSettled(
    targetChains,
    async (chain) => {
      const owner = resolveGovernanceOwner(
        governanceType as GovernanceType,
        ownerType as Owner,
        chain,
      );
      if (!owner) {
        logger.warn(`No ${ownerType} owner for ${chain}, skipping`);
        return;
      }

      logger.info(`Deploying ProxyAdmin on ${chain}...`);
      const proxyAdmin = await multiProvider.handleDeploy(
        chain,
        new ProxyAdmin__factory(),
        [],
      );
      const address = proxyAdmin.address;
      logger.info(`ProxyAdmin deployed at ${address} on ${chain}`);

      logger.info(`Transferring ownership to ${owner} on ${chain}...`);
      const tx = await proxyAdmin.transferOwnership(owner);
      await multiProvider.handleTx(chain, tx);
      logger.info(`Ownership transferred on ${chain}`);

      return { chain, proxyAdmin: address, owner };
    },
    (chain) => chain,
  );

  console.table([...fulfilled.values()]);

  if (rejected.size > 0) {
    for (const [chain, error] of rejected) {
      logger.error(`Failed on ${chain}`, error);
    }
    throw new Error(`ProxyAdmin deploy failed on ${rejected.size} chain(s)`);
  }
}

main().catch((err) => {
  logger.error('Deploy failed', err);
  process.exit(1);
});
