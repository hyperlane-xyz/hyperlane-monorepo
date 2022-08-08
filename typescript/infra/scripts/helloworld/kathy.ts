import { info } from 'console';
import { BigNumber } from 'ethers';
import { Counter, Gauge, Registry } from 'prom-client';
import { format } from 'util';

import { HelloWorldApp } from '@abacus-network/helloworld';
import {
  ChainName,
  Chains,
  InterchainGasCalculator,
} from '@abacus-network/sdk';
import { debug, error, log, utils } from '@abacus-network/utils';

import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { startMetricsServer } from '../../src/utils/metrics';
import { assertChain, diagonalize, sleep } from '../../src/utils/utils';
import {
  getArgs,
  getContext,
  getCoreEnvironmentConfig,
  getEnvironment,
} from '../utils';

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

/** The maximum number of messages we will allow to get queued up if we are sending too slowly. */
const MAX_MESSAGES_ALLOWED_TO_SEND = 5;

function getKathyArgs(validChains: ChainName[]) {
  return getArgs()
    .boolean('cycle-once')
    .describe(
      'cycle-once',
      'If true, will cycle through all chain pairs once as quick as possible',
    )
    .default('cycle-once', false)

    .number('full-cycle-time')
    .describe(
      'full-cycle-time',
      'How long it should take to go through all the message pairings in milliseconds. Ignored if --cycle-once is true. Defaults to 6 hours.',
    )
    .default('full-cycle-time', 1000 * 60 * 60 * 6) // 6 hrs

    .number('message-send-timeout')
    .describe(
      'message-send-timeout',
      'How long to wait for a message to be sent in milliseconds. Defaults to 10 min.',
    )
    .default('message-send-timeout', 10 * 60 * 1000) // 10 min

    .number('message-receipt-timeout')
    .describe(
      'message-receipt-timeout',
      'How long to wait for a message to be received on the destination in milliseconds. Defaults to 10 min.',
    )
    .default('message-receipt-timeout', 10 * 60 * 1000) // 10 min

    .string('chains-to-skip')
    .array('chains-to-skip')
    .describe('chains-to-skip', 'Chains to skip sending from or sending to.')
    .default('chains-to-skip', [])
    .coerce('chains-to-skip', (chainStrs: string[]) =>
      chainStrs.map((chainStr: string) => {
        const chain = assertChain(chainStr);
        // Ensure the specified chains are actually valid for the app
        if (!validChains.includes(chain)) {
          throw Error(
            `Chain to skip ${chain} invalid, not found in ${validChains}`,
          );
        }
        return chain;
      }),
    ).argv;
}

async function main() {
  startMetricsServer(metricsRegister);
  const environment = await getEnvironment();
  debug('Starting up', { environment });
  const coreConfig = getCoreEnvironmentConfig(environment);
  const context = await getContext();
  const app = await getApp(coreConfig, context, KEY_ROLE_ENUM.Kathy);
  const gasCalculator = InterchainGasCalculator.fromEnvironment(
    environment,
    app.multiProvider as any,
  );
  const appChains = app.chains() as Chains[];

  const argv = await getKathyArgs(appChains);

  const chains = appChains.filter(
    (chain) => !argv.chainsToSkip || !argv.chainsToSkip.includes(chain),
  );
  const pairings = diagonalize(
    chains.map((origin) =>
      chains.map((destination) =>
        origin == destination ? null : { origin, destination },
      ),
    ),
  )
    .filter((v) => v !== null)
    .map((v) => v!);

  debug('Pairings calculated', { chains, pairings });

  let allowedToSend: number;
  let currentPairingIndex: number;
  let sendFrequency: number | undefined;

  if (argv.cycleOnce) {
    // If we're cycling just once, we're allowed to send all the pairings
    allowedToSend = pairings.length;
    // Start with pairing 0
    currentPairingIndex = 0;

    debug('Cycling once through all pairs');
  } else {
    // If we are not cycling just once and are running this as a service, do so at an interval.
    // Track how many we are still allowed to send in case some messages send slower than expected.
    allowedToSend = 1;
    sendFrequency = FULL_CYCLE_TIME / pairings.length;
    // in case we are restarting kathy, keep it from always running the exact same messages first
    currentPairingIndex = Date.now() % pairings.length;

    debug('Running as a service', {
      sendFrequency,
    });

    setInterval(() => {
      // bucket cap since if we are getting really behind it probably does not make sense to let it run away.
      allowedToSend = Math.min(allowedToSend + 1, MAX_MESSAGES_ALLOWED_TO_SEND);
      debug('Tick; allowed to send another message', {
        allowedToSend,
        sendFrequency,
      });
    }, sendFrequency);
  }

  // init the metrics because it can take a while for kathy to get through everything and we do not
  // want the metrics to be reported as null in the meantime.
  for (const { origin, destination: remote } of pairings) {
    messagesSendCount.labels({ origin, remote, status: 'success' }).inc(0);
    messagesSendCount.labels({ origin, remote, status: 'failure' }).inc(0);
    messageSendSeconds.labels({ origin, remote }).inc(0);
    messageReceiptSeconds.labels({ origin, remote }).inc(0);
  }

  while (true) {
    currentPairingIndexGauge.set(currentPairingIndex);
    const { origin, destination } = pairings[currentPairingIndex];
    const labels = {
      origin,
      remote: destination,
    };
    const logCtx = {
      currentPairingIndex,
      origin,
      destination,
    };
    // wait until we are allowed to send the message; we don't want to send on
    // the interval directly because low intervals could cause multiple to be
    // sent concurrently. Using allowedToSend creates a token-bucket system that
    // allows for a few to be sent if one message takes significantly longer
    // than most do. It is also more accurate to do it this way for keeping the
    // interval schedule than to use a fixed sleep which would not account for
    // how long messages took to send.
    // In the cycle-once case, the loop is expected to exit before ever hitting
    // this condition.
    if (allowedToSend <= 0) {
      debug('Waiting before sending next message', {
        ...logCtx,
        sendFrequency,
      });
      while (allowedToSend <= 0) await sleep(1000);
    }
    allowedToSend--;

    debug('Initiating sending of new message', logCtx);

    try {
      await sendMessage(app, origin, destination, gasCalculator);
      log('Message sent successfully', { origin, destination });
      messagesSendCount.labels({ ...labels, status: 'success' }).inc();
    } catch (e) {
      error(`Error sending message, continuing...`, {
        error: format(e),
        ...logCtx,
      });
      messagesSendCount.labels({ ...labels, status: 'failure' }).inc();
    }

    // Print stats once every cycle through the pairings.
    // For the cycle-once case, it's important this checks if the current index is
    // the final index in pairings. For the long-running case, this index choice
    // is arbitrary.
    if (currentPairingIndex == pairings.length - 1) {
      for (const [origin, destinationStats] of Object.entries(
        await app.stats(),
      )) {
        for (const [destination, counts] of Object.entries(destinationStats)) {
          debug('Message stats', { origin, destination, ...counts });
        }
      }

      if (argv.cycleOnce) {
        info('Finished cycling through all pairs once');
        break;
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
  const receipt = await utils.timeout(
    app.sendHelloWorld(origin, destination, msg, value),
    MESSAGE_SEND_TIMEOUT,
    'Timeout sending message',
  );
  messageSendSeconds.labels(metricLabels).inc((Date.now() - startTime) / 1000);
  log('Message sent', {
    origin,
    destination,
    events: receipt.events,
    logs: receipt.logs,
  });

  await utils.timeout(
    app.waitForMessageReceipt(receipt),
    MESSAGE_RECEIPT_TIMEOUT,
    'Timeout waiting for message to be received',
  );
  messageReceiptSeconds
    .labels(metricLabels)
    .inc((Date.now() - startTime) / 1000);
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
