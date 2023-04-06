import {
  HyperlaneCore,
  HyperlaneIgp,
  MultiProvider,
  attachContractsMap,
  createRouterConfigMap,
} from '@hyperlane-xyz/sdk';

import { HelloWorldApp } from '../app/app';
import { helloWorldFactories } from '../app/contracts';
import { HelloWorldChecker } from '../deploy/check';
import { prodConfigs } from '../deploy/config';

// COPY FROM OUTPUT OF DEPLOYMENT SCRIPT OR IMPORT FROM ELSEWHERE
const deploymentAddresses = {};

// SET CONTRACT OWNER ADDRESS HERE
const ownerAddress = '0x123...';

async function check() {
  console.info('Preparing utilities');
  const multiProvider = new MultiProvider(prodConfigs);

  const contractsMap = attachContractsMap(
    deploymentAddresses,
    helloWorldFactories,
  );

  const core = HyperlaneCore.fromEnvironment('testnet', multiProvider);
  const igp = HyperlaneIgp.fromEnvironment('testnet', multiProvider);
  const app = new HelloWorldApp(core, contractsMap, multiProvider);
  const config = createRouterConfigMap(
    ownerAddress,
    core.contractsMap,
    igp.contractsMap,
  );

  console.info('Starting check');
  const helloWorldChecker = new HelloWorldChecker(multiProvider, app, config);
  await helloWorldChecker.check();
  helloWorldChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);
