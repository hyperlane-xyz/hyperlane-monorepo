import { ethers } from 'hardhat';

import { buildContracts } from '../../../contracts';
import { AbacusCore } from '../../../core/AbacusCore';
import { getMultiProviderFromConfigAndSigner } from '../../../deploy/utils';
import { RouterContracts } from '../../../router';
import { ChainMap, ChainName } from '../../../types';
import {
  EnvSubsetApp,
  EnvSubsetChecker,
  envSubsetFactories,
  testConfigs,
} from '../app';
import testEnvironmentAddresses from '../deploymentAddresses.json';

async function check() {
  const [signer] = await ethers.getSigners();
  const multiProvider = getMultiProviderFromConfigAndSigner(
    testConfigs,
    signer,
  );
  const contractsMap = buildContracts(
    testEnvironmentAddresses,
    envSubsetFactories,
  ) as ChainMap<ChainName, RouterContracts>;
  const app = new EnvSubsetApp(contractsMap, multiProvider);
  const core = AbacusCore.fromEnvironment('test', multiProvider);
  const config = core.extendWithConnectionClientConfig({
    test1: { owner: signer.address },
    test2: { owner: signer.address },
    test3: { owner: signer.address },
  });
  const envSubsetChecker = new EnvSubsetChecker(multiProvider, app, config);
  await envSubsetChecker.check();
  envSubsetChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);
