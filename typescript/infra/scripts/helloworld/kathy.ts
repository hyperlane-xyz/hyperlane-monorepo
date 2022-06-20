import { HelloWorldApp } from '@abacus-network/helloworld';
import { ChainName, Chains } from '@abacus-network/sdk';

import { getCoreEnvironmentConfig, getEnvironment } from '../utils';

import { getApp } from './utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const app = await getApp(coreConfig);
  const chains = app.chains() as Chains[];
  const skip = process.env.NETWORKS_TO_SKIP?.split(',');

  const invalidChain = chains.find((chain) => skip && !skip.includes(chain));
  if (invalidChain) {
    throw new Error(`Invalid chain to skip ${invalidChain}`);
  }

  const sources = chains.filter((chain) => !skip || !skip.includes(chain));
  for (const source of sources) {
    for (const destination of sources.slice().filter((d) => d !== source)) {
      await sendMessage(app, source, destination);
    }
  }
}

async function sendMessage(
  app: HelloWorldApp<any>,
  source: ChainName,
  destination: ChainName,
) {
  try {
    const receipt = await app.sendHelloWorld(
      source,
      destination,
      `Hello from ${source} to ${destination}!`,
    );
    console.log(JSON.stringify(receipt.events || receipt.logs));
  } catch (err) {
    console.error(`Error sending ${source} -> ${destination}`, err);
    // Propagate error up
    throw err;
  }
}

main()
  .then(() => console.info('HelloWorld sent'))
  .catch(console.error);
