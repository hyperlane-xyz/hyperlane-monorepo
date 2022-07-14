import { providers } from 'ethers';

import {
  AbacusCore,
  ChainMap,
  ChainName,
  buildContracts,
  getChainToOwnerMap,
  getMultiProviderFromConfigAndProvider,
} from '@abacus-network/sdk';

import { HelloWorldApp } from '../app/app';
import { HelloWorldContracts, helloWorldFactories } from '../app/contracts';
import { HelloWorldChecker } from '../deploy/check';
import { prodConfigs } from '../deploy/config';

// COPY FROM OUTPUT OF DEPLOYMENT SCRIPT OR IMPORT FROM ELSEWHERE
const deploymentAddresses = {};

// SET CONTRACT OWNER ADDRESS HERE
const ownerAddress = '0x123...';

async function check() {
  console.info('Getting provider');
  const provider = new providers.JsonRpcProvider('URL_HERE');

  console.info('Preparing utilities');
  const multiProvider = getMultiProviderFromConfigAndProvider(
    prodConfigs,
    provider,
  );
  const contractsMap = buildContracts(
    deploymentAddresses,
    helloWorldFactories,
  ) as ChainMap<ChainName, HelloWorldContracts>;
  const app = new HelloWorldApp(contractsMap, multiProvider);

  const core = AbacusCore.fromEnvironment('testnet2', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(prodConfigs, ownerAddress),
  );

  console.info('Starting check');
  const helloWorldChecker = new HelloWorldChecker(multiProvider, app, config);
  await helloWorldChecker.check();
  helloWorldChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);
