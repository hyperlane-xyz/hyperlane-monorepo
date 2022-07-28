import { BigNumber } from 'ethers';
import { Counter, Gauge, Registry } from 'prom-client';
import { format } from 'util';

import { HelloWorldApp } from '@abacus-network/helloworld';
import {
  ChainName,
  Chains,
  InterchainGasCalculator,
} from '@abacus-network/sdk';

import { debug, error, log } from '../../src/utils/logging';
import { startMetricsServer } from '../../src/utils/metrics';
import { diagonalize, sleep } from '../../src/utils/utils';
import { getCoreEnvironmentConfig, getEnvironment } from '../utils';

import { getApp } from './utils';

const metricsRegister = new Registry();
const messagesSendCount = new Counter({
  name: 'abacus_kathy_messages',
  help: 'Count of messages sent; records successes and failures by status label',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote', 'status'],
});
const currentPairingIndexGauge = new Gauge({
  name: 'abacus_kathy_pairing_index',
  help: 'The current message pairing index kathy is on, this is useful for seeing if kathy is always crashing around the same pairing as pairings are deterministically ordered.',
  registers: [metricsRegister],
  labelNames: [],
});
const messageSendSeconds = new Counter({
  name: 'abacus_kathy_message_send_seconds',
  help: 'Total time spent waiting on messages to get sent not including time spent waiting on it to be received.',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote'],
});
const messageReceiptSeconds = new Counter({
  name: 'abacus_kathy_message_receipt_seconds',
  help: 'Total time spent waiting on messages to be received including time to be sent.',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote'],
});

metricsRegister.registerMetric(messagesSendCount);
metricsRegister.registerMetric(currentPairingIndexGauge);
metricsRegister.registerMetric(messageSendSeconds);
metricsRegister.registerMetric(messageReceiptSeconds);

/** How long we should take to go through all the message pairings in milliseconds. 6hrs by default. */
const FULL_CYCLE_TIME =
  parseInt(process.env['KATHY_FULL_CYCLE_TIME'] as string) ||
  1000 * 60 * 60 * 6;
if (!Number.isSafeInteger(FULL_CYCLE_TIME) || FULL_CYCLE_TIME <= 0) {
  error('Invalid cycle time provided');
  process.exit(1);
}

/** How long we should wait for a message to be sent in milliseconds. 10 min by default. */
const MESSAGE_SEND_TIMEOUT =
  parseInt(process.env['KATHY_MESSAGE_SEND_TIMEOUT'] as string) ||
  10 * 60 * 1000;

/** How long we should wait for a message to be received in milliseconds. 10 min by default. */
const MESSAGE_RECEIPT_TIMEOUT =
  parseInt(process.env['KATHY_MESSAGE_RECEIPT_TIMEOUT'] as string) ||
  10 * 60 * 1000;

/** On an error sending a message, how many times to retry. */
const MAX_SEND_RETRIES =
  parseInt(process.env['KATHY_MAX_SEND_RETRIES'] as string) || 0;
if (!Number.isSafeInteger(MAX_SEND_RETRIES) || MAX_SEND_RETRIES < 0) {
  error('Invalid max send retires provided');
  process.exit(1);
}

async function main() {
  startMetricsServer(metricsRegister);
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const app = await getApp(coreConfig);
  const gasCalculator = InterchainGasCalculator.fromEnvironment(
    environment,
    app.multiProvider as any,
  );
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

  const origins = chains.filter((chain) => !skip || !skip.includes(chain));
  const pairings = diagonalize(
    origins.map((origin) =>
      origins.map((destination) =>
        origin == destination ? null : { origin, destination },
      ),
    ),
  )
    .filter((v) => v !== null)
    .map((v) => v!);

  // track how many we are still allowed to send in case some messages send slower than expected.
  let allowedToSend = 0;
  setInterval(() => {
    allowedToSend++;
  }, FULL_CYCLE_TIME / pairings.length);

  for (
    // in case we are restarting kathy, keep it from always running the exact same messages first
    let currentPairingIndex = Date.now() % pairings.length;
    ;
    currentPairingIndex = (currentPairingIndex + 1) % pairings.length
  ) {
    currentPairingIndexGauge.set(currentPairingIndex);
    // wait until we are allowed to send the message
    while (allowedToSend <= 0) await sleep(1000);
    allowedToSend--;

    const { origin, destination } = pairings[currentPairingIndex];
    const labels = {
      origin,
      remote: destination,
    };

    for (
      let attempt = 1, needToRetry = true;
      attempt <= MAX_SEND_RETRIES + 1 && needToRetry;
      ++attempt
    ) {
      const startTime = Date.now();
      try {
        await sendMessage(app, origin, destination, gasCalculator);
        needToRetry = false;
        log('Message sent successfully', { origin, destination, attempt });
        messagesSendCount.labels({ ...labels, status: 'success' }).inc();
      } catch (e) {
        error(`Error sending message, continuing...`, {
          error: format(e),
          origin,
          destination,
          attempt,
        });
        messagesSendCount.labels({ ...labels, status: 'failure' }).inc();
      }

      messageSendSeconds.labels(labels).inc((Date.now() - startTime) / 1000);
    }

    // print stats once every cycle through the pairings
    if (currentPairingIndex == 0) {
      for (const [origin, destinationStats] of Object.entries(
        await app.stats(),
      )) {
        for (const [destination, counts] of Object.entries(destinationStats)) {
          debug('Message stats', { origin, destination, ...counts });
        }
      }
    }
  }
}

async function sendMessage(
  app: HelloWorldApp<any>,
  origin: ChainName,
  destination: ChainName,
  gasCalc: InterchainGasCalculator<any>,
) {
  const startTime = Date.now();
  const msg = 'Hello!';
  const expectedHandleGas = BigNumber.from(100_000);
  const value = await gasCalc.estimatePaymentForHandleGas(
    origin,
    destination,
    expectedHandleGas,
  );
  const metricLabels = { origin, remote: destination };

  log('Sending message', { origin, destination });
  const receipt = await app.sendHelloWorld(
    origin,
    destination,
    msg,
    value,
    MESSAGE_SEND_TIMEOUT,
  );
  messageSendSeconds.labels(metricLabels).inc(Date.now() - startTime);
  log('Message sent', {
    origin,
    destination,
    events: receipt.events,
    logs: receipt.logs,
  });

  await app.waitForMessageReceipt(receipt, MESSAGE_RECEIPT_TIMEOUT);
  messageReceiptSeconds.labels(metricLabels).inc(Date.now() - startTime);
  log('Message received', {
    origin,
    destination,
  });
}

main()
  .then(() => {
    error('Main exited');
    process.exit(1);
  })
  .catch((e) => {
    error('Error in main', { error: format(e) });
    process.exit(1);
  });
