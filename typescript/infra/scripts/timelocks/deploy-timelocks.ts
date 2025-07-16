import {
  EvmTimelockDeployer,
  TimelockConfigMap,
  TimelockConfigMapSchema,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { Role } from '../../src/roles.js';
import { readYaml } from '../../src/utils/utils.js';
import { getArgs, withInputFile } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { inputFile, environment } = await withInputFile(getArgs()).argv;

  let rawConfig: TimelockConfigMap;
  if (inputFile) {
    rawConfig = readYaml(inputFile);
  } else {
    // TODO: Some other way to get the config
    throw new Error(
      'Alternative way to get timelock deploy config not implemented',
    );
  }

  const parsedRawConfig = TimelockConfigMapSchema.safeParse(rawConfig);
  if (!parsedRawConfig.success) {
    rootLogger.error('Error parsing Timelock deployment config:');
    console.dir(parsedRawConfig, { depth: null });
    console.dir(parsedRawConfig.error.format(), { depth: null });
    process.exit(1);
  }

  const config: TimelockConfigMap = parsedRawConfig.data;
  const deploymentChains = Object.keys(config);

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    deploymentChains,
  );

  const timelockDeployer = new EvmTimelockDeployer(multiProvider);

  rootLogger.info(
    `Starting deployment of TimelockController contracts on chains: ${deploymentChains}...`,
  );
  const deployMap = await timelockDeployer.deploy(config);

  rootLogger.info(`Successfully deployed TimelockController contracts:`);
  for (const [
    chain,
    {
      TimelockController: { address },
    },
  ] of Object.entries(deployMap)) {
    const explorerUrl = multiProvider.getExplorerUrl(chain);
    rootLogger.info(
      `chain: ${chain}, address: ${address},  explorer_url: ${explorerUrl}/address/${address}`,
    );
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
