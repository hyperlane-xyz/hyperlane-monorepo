import { Wallet } from 'ethers';

import {
  AbacusCore,
  ChainMap,
  ChainName,
  buildContracts,
  getChainToOwnerMap,
  getMultiProviderFromConfigAndSigner,
} from '@abacus-network/sdk';

import { HelloWorldApp } from '../app/app';
import { HelloWorldContracts, helloWorldFactories } from '../app/contracts';
import { HelloWorldChecker } from '../deploy/check';
import { prodConfigs } from '../deploy/config';

// COPY FROM OUTPUT OF DEPLOYMENT SCRIPT OR IMPORT FROM ELSEWHERE
const deploymentAddresses = {};

async function check() {
  console.info('Getting signer');
  const signer = new Wallet('SET KEY HERE OR CREATE YOUR OWN SIGNER');

  console.info('Preparing utilities');
  const multiProvider = getMultiProviderFromConfigAndSigner(
    prodConfigs,
    signer,
  );
  const contractsMap = buildContracts(
    deploymentAddresses,
    helloWorldFactories,
  ) as ChainMap<ChainName, HelloWorldContracts>;
  const app = new HelloWorldApp(contractsMap, multiProvider);

  const core = AbacusCore.fromEnvironment('testnet2', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(prodConfigs, signer.address),
  );

  console.info('Starting check');
  const helloWorldChecker = new HelloWorldChecker(multiProvider, app, config);
  await helloWorldChecker.check();
  helloWorldChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);
