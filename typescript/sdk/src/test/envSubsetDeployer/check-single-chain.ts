import { buildContracts } from '../../contracts';
import { HyperlaneCore } from '../../core/HyperlaneCore';
import { HyperlaneIgp } from '../../gas/HyperlaneIgp';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap } from '../../types';
import { createRouterConfigMap } from '../testUtils';

import {
  EnvSubsetApp,
  EnvSubsetChecker,
  TestRouterContracts,
  testRouterFactories,
} from './app';

// Copied from output of deploy-single-chain.ts script
const deploymentAddresses = {
  alfajores: {
    router: '0x0666AD4F636210B6a418f97790b7BAABAC54b9A4',
  },
};

const ownerAddress = '0x35b74Ed5038bf0488Ff33bD9819b9D12D10A7560';

async function check() {
  console.info('Preparing utilities');
  const multiProvider = new MultiProvider();

  const contractsMap = buildContracts(
    deploymentAddresses,
    testRouterFactories,
  ) as ChainMap<TestRouterContracts>;
  const app = new EnvSubsetApp(contractsMap, multiProvider);
  const core = HyperlaneCore.fromEnvironment('testnet', multiProvider);
  const igp = HyperlaneIgp.fromEnvironment('testnet', multiProvider);
  const config = createRouterConfigMap(
    ownerAddress,
    core.contractsMap,
    igp.contractsMap,
  );

  const envSubsetChecker = new EnvSubsetChecker(multiProvider, app, config);

  console.info('Starting check');
  await envSubsetChecker.check();
  envSubsetChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);
