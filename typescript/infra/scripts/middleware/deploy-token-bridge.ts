import path from 'path';

import {
  HyperlaneCore,
  TokenBridgeDeployer,
  objMap,
  tokenBridgeFactories,
} from '@hyperlane-xyz/sdk';

import { circleBridgeAdapterConfig } from '../../config/environments/testnet2/token-bridge';
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
  const core = HyperlaneCore.fromEnvironment(environment, multiProvider as any);

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'middleware/token-bridge',
  );

  // config gcp deployer key as owner
  const ownerConfigMap = await getConfiguration(environment, multiProvider);

  const deployer = new TokenBridgeDeployer(
    multiProvider,
    objMap(circleBridgeAdapterConfig, (chain, conf) => ({
      bridgeAdapterConfigs: [conf],
      ...ownerConfigMap[chain],
    })),
    core,
    'TokenBridgeDeploy2',
  );

  await deployWithArtifacts(dir, tokenBridgeFactories, deployer);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);
