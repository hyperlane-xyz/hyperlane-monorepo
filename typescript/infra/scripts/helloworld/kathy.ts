import { HelloWorldApp } from '@abacus-network/helloworld';
import { ChainName } from '@abacus-network/sdk';

import { getCoreEnvironmentConfig, getEnvironment } from '../utils';

import { getApp } from './utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const app = await getApp(coreConfig);
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
