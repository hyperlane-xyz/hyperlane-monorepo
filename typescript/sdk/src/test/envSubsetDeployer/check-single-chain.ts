import { buildContracts } from '../../contracts';
import { AbacusCore } from '../../core/AbacusCore';
import {
  getChainToOwnerMap,
  getMultiProviderFromConfigAndProvider,
} from '../../deploy/utils';
import { RouterContracts } from '../../router';
import { ChainMap, ChainName } from '../../types';

import {
  EnvSubsetApp,
  EnvSubsetChecker,
  alfajoresChainConfig,
  envSubsetFactories,
} from './app';
import { getAlfajoresProvider } from './utils';

// Copied from output of deploy-single-chain.ts script
const deploymentAddresses = {
  alfajores: {
    router: '0x41C5cF9f3745F90662f202CDc61Afd2f2941e890',
  },
};

const ownerAddress = '0x35b74Ed5038bf0488Ff33bD9819b9D12D10A7560';

async function check() {
  const provider = getAlfajoresProvider();

  console.info('Preparing utilities');
  const multiProvider = getMultiProviderFromConfigAndProvider(
    alfajoresChainConfig,
    provider,
  );
  const contractsMap = buildContracts(
    deploymentAddresses,
    envSubsetFactories,
  ) as ChainMap<ChainName, RouterContracts>;
  const app = new EnvSubsetApp(contractsMap, multiProvider);
  const core = AbacusCore.fromEnvironment('testnet2', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(alfajoresChainConfig, ownerAddress),
  );
  const envSubsetChecker = new EnvSubsetChecker(multiProvider, app, config);

  console.info('Starting check');
  await envSubsetChecker.check();
  envSubsetChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);
