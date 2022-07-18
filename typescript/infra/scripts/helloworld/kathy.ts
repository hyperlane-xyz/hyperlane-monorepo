import { Counter, Registry } from 'prom-client';

import { HelloWorldApp } from '@abacus-network/helloworld';
import { ChainName, Chains } from '@abacus-network/sdk';

import { submitMetrics } from '../../src/utils/metrics';
import { sleep } from '../../src/utils/utils';
import { getCoreEnvironmentConfig, getEnvironment } from '../utils';

import { getApp } from './utils';

const constMetricLabels = {
  // this needs to get set in main because of async reasons
  abacus_deployment: '',
  abacus_context: 'abacus',
};

const metricsRegister = new Registry();
const messagesCount = new Counter({
  name: 'abacus_kathy_messages',
  help: 'Test messages which have been sent with',
  registers: [metricsRegister],
  labelNames: [
    'origin',
    'remote',
    'status',
    ...(Object.keys(constMetricLabels) as (keyof typeof constMetricLabels)[]),
  ],
});
metricsRegister.registerMetric(messagesCount);

async function main() {
  const environment = await getEnvironment();
  constMetricLabels.abacus_deployment = environment;
  const coreConfig = getCoreEnvironmentConfig(environment);
  const app = await getApp(coreConfig);
  const chains = app.chains() as Chains[];
  const skip = process.env.CHAINS_TO_SKIP?.split(',').filter(
    (skipChain) => skipChain.length > 0,
  );

  const invalidChains = skip?.filter(
    (skipChain: any) => !chains.includes(skipChain),
  );
  if (invalidChains && invalidChains.length > 0) {
    throw new Error(`Invalid chains to skip ${invalidChains}`);
  }

  let failureOccurred = false;

  const sources = chains.filter((chain) => !skip || !skip.includes(chain));
  for (const source of sources) {
    for (const destination of sources.filter((d) => d !== source)) {
      const labels = {
        origin: source,
        remote: destination,
        ...constMetricLabels,
      };
      try {
        await sendMessage(app, source, destination);
        messagesCount.labels({ ...labels, status: 'success' }).inc();
      } catch (err) {
        console.error(
          `Error sending message from ${source} to ${destination}, continuing...`,
          `${err}`.replaceAll('\n', ' ## '),
        );
        failureOccurred = true;
        messagesCount.labels({ ...labels, status: 'failure' }).inc();
      }
      // Sleep 500ms to avoid race conditions where nonces are reused
      await sleep(500);
    }
  }

  await submitMetrics(metricsRegister, 'kathy');

  if (failureOccurred) {
    console.error('Failure occurred at least once');
    process.exit(1);
  }
}

async function sendMessage(
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
