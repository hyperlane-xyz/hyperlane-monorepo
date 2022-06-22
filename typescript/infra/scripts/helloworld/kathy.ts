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

export async function sendMessage(
  app: HelloWorldApp<any>,
  source: ChainName,
  destination: ChainName,
) {
  console.log(`Sending message from ${source} to ${destination}`);
  const receipt = await app.sendHelloWorld(source, destination, `Hello!`);
  console.log(JSON.stringify(receipt.events || receipt.logs));
}

main()
  .then(() => console.info('HelloWorld sent'))
  .catch(console.error);
