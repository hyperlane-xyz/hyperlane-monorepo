import {
  ChainMap,
  HyperlaneIsmFactory,
  TestRecipientConfig,
  TestRecipientDeployer,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  DeployCache,
  deployWithArtifacts,
} from '../../src/deployment/deploy.js';
import {
  getIsmConfigMap,
  getKesselRunMultiProvider,
} from '../../src/kesselrunner/config.js';
import { Modules } from '../agent-utils.js';

async function deployTestRecipients() {
  const { environment, multiProvider, targetNetworks, registry } =
    await getKesselRunMultiProvider();

  const registryAddresses = await registry.getAddresses();

  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    registryAddresses,
    multiProvider,
  );

  const config: ChainMap<TestRecipientConfig> = {};
  const ismConfigMap = getIsmConfigMap(targetNetworks);

  await Promise.all(
    targetNetworks.map(async (chain) => {
      const ism = await ismFactory.deploy({
        destination: chain,
        config: ismConfigMap[chain],
      });
      config[chain] = {
        interchainSecurityModule: ism.address,
      };
    }),
  );

  const deployer = new TestRecipientDeployer(multiProvider, undefined, true);
  const cache: DeployCache = {
    verification: '',
    read: false,
    write: false,
    environment,
    module: Modules.TEST_RECIPIENT,
  };

  await deployWithArtifacts({
    configMap: config,
    deployer,
    cache,
    targetNetworks,
    module: Modules.TEST_RECIPIENT,
    multiProvider,
    concurrentDeploy: true,
  });

  const table = Object.entries(deployer.cachedAddresses).map(
    ([chain, { testRecipient }]) => ({
      chain,
      testRecipient,
    }),
  );
  // eslint-disable-next-line no-console
  console.table(table);
}

deployTestRecipients().catch((error) => {
  rootLogger.error('Error deploying test recipients:', error);
  process.exit(1);
});
