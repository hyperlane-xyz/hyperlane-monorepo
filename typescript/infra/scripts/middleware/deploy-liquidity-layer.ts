import path from 'path';

import {
  LiquidityLayerDeployer,
  liquidityLayerFactories,
  objMap,
} from '@hyperlane-xyz/sdk';

import { bridgeAdapterConfigs } from '../../config/environments/testnet3/token-bridge';
import { deployWithArtifacts } from '../../src/deploy';
import { getConfiguration } from '../helloworld/utils';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'middleware/liquidity-layer',
  );

  // config gcp deployer key as owner
  const ownerConfigMap = await getConfiguration(environment, multiProvider);
  const config = objMap(bridgeAdapterConfigs, (chain, conf) => ({
    ...conf,
    ...ownerConfigMap[chain],
  }));
  const deployer = new LiquidityLayerDeployer(
    multiProvider,
    config,
    'LiquidityLayerDeploy2',
  );
  await deployWithArtifacts(dir, liquidityLayerFactories, deployer);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);
