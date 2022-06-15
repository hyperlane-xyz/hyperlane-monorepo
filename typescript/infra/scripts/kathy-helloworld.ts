import { HelloWorldApp } from '@abacus-network/helloworld';
import {
  HelloWorldContracts,
  helloWorldFactories,
} from '@abacus-network/helloworld/dist/sdk/contracts';
import { ChainMap, ChainName, buildContracts } from '@abacus-network/sdk';

import addresses from '../config/environments/testnet2/helloworld/addresses.json';

import { getCoreEnvironmentConfig } from './utils';

async function main() {
  const environment = 'testnet2';
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const contracts = buildContracts(addresses, helloWorldFactories) as ChainMap<
    keyof typeof addresses,
    HelloWorldContracts
  >;
  const app = new HelloWorldApp(contracts, multiProvider);
  const sources = app.chains();
  await Promise.all(
    sources.map((source) => {
      const destinations = sources.slice().filter((d) => d !== source);
      return Promise.all(
        destinations.map((destination) =>
          sendMessage(app, source, destination),
        ),
      );
    }),
  );
}

async function sendMessage(
  app: HelloWorldApp<any>,
  source: ChainName,
  destination: ChainName,
) {
  const receipt = await app.sendHelloWorld(
    source,
    destination,
    `Hello from ${source} to ${destination}!`,
  );
  console.log(JSON.stringify(receipt.events || receipt.logs));
}

main()
  .then(() => console.info('HelloWorld sent'))
  .catch(console.error);
