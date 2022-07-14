import { buildContracts } from '../../contracts';
import { AbacusCore } from '../../core/AbacusCore';
import {
  getChainToOwnerMap,
  getMultiProviderFromConfigAndSigner,
} from '../../deploy/utils';
import { RouterContracts } from '../../router';
import { ChainMap, ChainName } from '../../types';

import {
  EnvSubsetApp,
  EnvSubsetChecker,
  alfajoresChainConfig,
  envSubsetFactories,
} from './app';
import { getAlfajoresSigner } from './utils';

// Copied from output of deploy-single-chain.ts script
const deploymentAddresses = {
  alfajores: {
    router: '0xC02B8798a67eFA421B24A7C87Af870A17579290d',
  },
};

async function check() {
  const signer = getAlfajoresSigner();

  console.info('Preparing utilities');
  const multiProvider = getMultiProviderFromConfigAndSigner(
    alfajoresChainConfig,
    signer,
  );
  const contractsMap = buildContracts(
    deploymentAddresses,
    envSubsetFactories,
  ) as ChainMap<ChainName, RouterContracts>;
  const app = new EnvSubsetApp(contractsMap, multiProvider);
  const core = AbacusCore.fromEnvironment('testnet2', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(alfajoresChainConfig, signer.address),
  );
  const envSubsetChecker = new EnvSubsetChecker(multiProvider, app, config);

  console.info('Starting check');
  await envSubsetChecker.check();
  envSubsetChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);
