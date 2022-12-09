import path from 'path';

import {
  ChainNameToDomainId,
  HyperlaneCore,
  V2CompatibilityRouterDeployer,
  objMap,
  v2CompatibilityFactories,
} from '@hyperlane-xyz/sdk';

import { deployWithArtifacts } from '../../src/deploy';
import { getConfiguration } from '../helloworld/utils';
import { mergeWithSdkContractAddressArtifacts } from '../merge-sdk-contract-addresses';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

// similar to hello world deploy script but uses freshly funded account for consistent addresses across chains
// should eventually be deduped
async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const core = HyperlaneCore.fromEnvironment(environment, multiProvider as any);

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'middleware/v2compatibility',
  );

  // config gcp deployer key as owner
  const configMap = await getConfiguration(environment, multiProvider);
  const v1Domains = Object.keys(configMap).map((_) => ChainNameToDomainId[_]);
  // V2 Domain IDs are just the chain IDs
  const v2Domains = await Promise.all(
    Object.keys(configMap).map((_) =>
      multiProvider
        .getChainConnection(_)
        .provider.getNetwork()
        .then((_) => _.chainId),
    ),
  );

  console.log(v1Domains, v2Domains);
  const deployer = new V2CompatibilityRouterDeployer(
    multiProvider,
    objMap(configMap, (_, c) => ({ ...c, v1Domains, v2Domains })),
    core,
    'v2compatibilitymiddleware3',
  );

  await deployWithArtifacts(dir, v2CompatibilityFactories, deployer);
  await mergeWithSdkContractAddressArtifacts(environment);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);
