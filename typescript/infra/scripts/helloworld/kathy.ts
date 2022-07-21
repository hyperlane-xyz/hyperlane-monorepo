import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';

import { HelloWorldApp } from '@abacus-network/helloworld';
import { ChainName, Chains } from '@abacus-network/sdk';

import { error, log } from '../../src/utils/logging';
import { submitMetrics } from '../../src/utils/metrics';
import { diagonalize, sleep } from '../../src/utils/utils';
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

  const sources = chains.filter((chain) => !skip || !skip.includes(chain));
  const pairings = diagonalize(
    sources.map((source) =>
      sources.map((destination) =>
        source == destination ? null : { source, destination },
      ),
    ),
  ).filter((v) => !!v);

  for (
    // in case we are restarting kathy, keep it from always running the exact same messages first
    let currentPairingIndex = Date.now() % pairings.length;
    ;
    currentPairingIndex = (currentPairingIndex + 1) % pairings.length
  ) {
    const { source, destination } = pairings[currentPairingIndex];
    const labels = {
      origin: source,
      remote: destination,
      ...constMetricLabels,
    };
    try {
      await sendMessage(app, source, destination);
      log('Message sent successfully', { from: source, to: destination });
      messagesSendStatus.labels({ ...labels }).set(1);
    } catch (e) {
      error(`Error sending message, continuing...`, {
        error: e,
        from: source,
        to: destination,
      });
      messagesSendStatus.labels({ ...labels }).set(0);
    }

    // Sleep 500ms to avoid race conditions where nonces are reused
    await sleep(500);
  }

  for (const [from, destinationStats] of Object.entries(await app.stats())) {
    for (const [to, counts] of Object.entries(destinationStats)) {
      log('Message stats', { from, to, ...counts });
    }
  }

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

  await new Promise<ethers.ContractReceipt[]>((resolve, reject) => {
    setTimeout(
      () => reject(new Error('Timeout waiting for message receipt')),
      10 * 60 * 1000,
    );
    app
      .sendHelloWorld(source, destination, 'Hello!', (receipt) => {
        log('Message sent', {
          from: source,
          to: destination,
          events: receipt.events,
          logs: receipt.logs,
        });
      })
      .then(resolve)
      .catch(reject);
  });
}

main()
  .then(() => log('HelloWorld sent'))
  .catch(error);
