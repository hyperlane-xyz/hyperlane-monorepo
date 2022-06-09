import { HelloWorldApp } from '@abacus-network/helloworld';
import {
  HelloWorldContracts,
  helloWorldFactories,
} from '@abacus-network/helloworld/dist/sdk/contracts';
import { ChainMap, buildContracts } from '@abacus-network/sdk';

import addresses from '../helloworld.json';

import { getCoreEnvironmentConfig } from './utils';

async function main() {
  const environment = 'testnet2';
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  type Chains = keyof typeof addresses;
  const contracts = buildContracts(addresses, helloWorldFactories) as ChainMap<
    Chains,
    HelloWorldContracts
  >;
  const app = new HelloWorldApp(contracts, multiProvider);
  const sources = Object.keys(addresses) as Chains[];
  for (const source in sources) {
    const destinations: Chains[] = sources.filter((d) => d !== source);
    for (const destination in destinations) {
      const receipt = await app.sendHelloWorld(
        source as Chains,
        destination as Chains,
        `Hello from ${source}`,
      );
      console.log({ source, destination, receipt });
    }
  }
}

main().then(console.log).catch(console.error);
