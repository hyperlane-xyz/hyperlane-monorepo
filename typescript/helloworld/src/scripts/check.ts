import { chainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  HyperlaneCore,
  MultiProvider,
  attachContractsMap,
} from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import { HelloWorldApp } from '../app/app.js';
import { helloWorldFactories } from '../app/contracts.js';
import { HelloWorldChecker } from '../deploy/check.js';
import { prodConfigs } from '../deploy/config.js';

// COPY FROM OUTPUT OF DEPLOYMENT SCRIPT OR IMPORT FROM ELSEWHERE
const deploymentAddresses: ChainMap<Record<string, Address>> = {};

// SET CONTRACT OWNER ADDRESS HERE
const ownerAddress = '0x123...';

async function check() {
  console.info('Preparing utilities');
  const multiProvider = new MultiProvider(prodConfigs);

  const contractsMap = attachContractsMap(
    deploymentAddresses,
    helloWorldFactories,
  );

  // If the default registry does not contain the core contract addresses you need,
  // Replace `chainAddresses` with a custom map of addresses
  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);
  const app = new HelloWorldApp(core, contractsMap, multiProvider);
  const config = core.getRouterConfig(ownerAddress);

  console.info('Starting check');
  const helloWorldChecker = new HelloWorldChecker(multiProvider, app, config);
  await helloWorldChecker.check();
  helloWorldChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);
