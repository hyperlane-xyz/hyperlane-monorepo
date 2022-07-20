import { Gauge, Registry } from 'prom-client';

import { HelloWorldApp } from '@abacus-network/helloworld';
import { ChainName, Chains } from '@abacus-network/sdk';

import { debug, error, log, warn } from '../../src/utils/logging';
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
const messagesSendStatus = new Gauge({
  name: 'abacus_kathy_messages',
  help: 'Whether messages which have been sent from one chain to another successfully; will report 0 for unsuccessful and 1 for successful.',
  registers: [metricsRegister],
  labelNames: [
    'origin',
    'remote',
    ...(Object.keys(constMetricLabels) as (keyof typeof constMetricLabels)[]),
  ],
});
metricsRegister.registerMetric(messagesSendStatus);

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

  // submit frequently so we don't have to wait a super long time for info to get into the metrics
  const metricsInterval = setInterval(() => {
    submitMetrics(metricsRegister, 'kathy', { appendMode: true }).catch((e) =>
      error('Failed to submit metrics', { error: e }),
    );
  }, 1000 * 30);

  for (const source of sources) {
    for (const destination of sources.filter((d) => d !== source)) {
      const labels = {
        origin: source,
        remote: destination,
        ...constMetricLabels,
      };
      try {
        await sendMessage(app, source, destination);
        messagesSendStatus.labels({ ...labels }).set(1);
      } catch (e) {
        error(`Error sending message, continuing...`, {
          error: e,
          from: source,
          to: destination,
        });
        failureOccurred = true;
        messagesSendStatus.labels({ ...labels }).set(0);
      }

      // Sleep 500ms to avoid race conditions where nonces are reused
      await sleep(500);
    }
  }

  clearInterval(metricsInterval);
  // do not use append mode here so we can clear any old pairings we no longer care about.
  await submitMetrics(metricsRegister, 'kathy', { appendMode: false });

  if (failureOccurred) {
    error('Failure occurred at least once');
    process.exit(1);
  }
}

async function sendMessage(
  app: HelloWorldApp<any>,
  source: ChainName,
  destination: ChainName,
) {
  log('Sending message', { from: source, to: destination });
  const receipt = await app.sendHelloWorld(source, destination, 'Hello!');

  debug('Message sent', { events: receipt.events, logs: receipt.logs });
}

main()
  .then(() => log('HelloWorld sent'))
  .catch(error);
