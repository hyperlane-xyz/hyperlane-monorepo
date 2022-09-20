import { buildContracts } from '../../contracts';
import { HyperlaneCore } from '../../core/HyperlaneCore';
import { getChainToOwnerMap } from '../../deploy/utils';
import { MultiProvider } from '../../providers/MultiProvider';
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
    router: '0x0666AD4F636210B6a418f97790b7BAABAC54b9A4',
  },
};

const ownerAddress = '0x35b74Ed5038bf0488Ff33bD9819b9D12D10A7560';

async function check() {
  const provider = getAlfajoresProvider();

  console.info('Preparing utilities');
  const multiProvider = new MultiProvider({
    alfajores: {
      provider,
      confirmations: alfajoresChainConfig.alfajores.confirmations,
      overrides: alfajoresChainConfig.alfajores.overrides,
    },
  });

  const contractsMap = buildContracts(
    deploymentAddresses,
    envSubsetFactories,
  ) as ChainMap<ChainName, RouterContracts>;
  const app = new EnvSubsetApp(contractsMap, multiProvider);
  const core = HyperlaneCore.fromEnvironment('testnet2', multiProvider);
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
