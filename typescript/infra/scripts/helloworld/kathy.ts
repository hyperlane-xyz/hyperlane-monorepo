import { BigNumber, ethers } from 'ethers';
import { Counter, Gauge, Registry } from 'prom-client';
import { format } from 'util';

import { HelloWorldApp } from '@abacus-network/helloworld';
import {
  ChainName,
  Chains,
  InterchainGasCalculator,
} from '@abacus-network/sdk';
import { debug, error, log, utils, warn } from '@abacus-network/utils';

import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { startMetricsServer } from '../../src/utils/metrics';
import { diagonalize, sleep } from '../../src/utils/utils';
import { getContext, getCoreEnvironmentConfig, getEnvironment } from '../utils';

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
const walletBalance = new Gauge({
  name: 'abacus_wallet_balance',
  help: 'Current balance of eth and other tokens in the `tokens` map for the wallet addresses in the `wallets` set',
  registers: [metricsRegister],
  labelNames: [
    'chain',
    'wallet_address',
    'wallet_name',
    'token_address',
    'token_symbol',
    'token_name',
  ],
});

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

  debug('Pairings calculated', { chains, pairings });

  // track how many we are still allowed to send in case some messages send slower than expected.
  let allowedToSend = 1;
  const sendFrequency = FULL_CYCLE_TIME / pairings.length;
  setInterval(() => {
    // bucket cap since if we are getting really behind it probably does not make sense to let it run away.
    allowedToSend = Math.min(allowedToSend + 1, MAX_MESSAGES_ALLOWED_TO_SEND);
    debug('Tick; allowed to send another message', {
      allowedToSend,
      sendFrequency,
    });
  }, sendFrequency);

  // init the metrics because it can take a while for kathy to get through everything and we do not
  // want the metrics to be reported as null in the meantime.
  for (const { origin, destination: remote } of pairings) {
    messagesSendCount.labels({ origin, remote, status: 'success' }).inc(0);
    messagesSendCount.labels({ origin, remote, status: 'failure' }).inc(0);
    messageSendSeconds.labels({ origin, remote }).inc(0);
    messageReceiptSeconds.labels({ origin, remote }).inc(0);
  }
  await Promise.all(
    origins.map(async (origin) => {
      await updateWalletBalanceMetricFor(app, origin);
    }),
  );

  for (
    // in case we are restarting kathy, keep it from always running the exact same messages first
    let currentPairingIndex = Date.now() % pairings.length;
    ;
    currentPairingIndex = (currentPairingIndex + 1) % pairings.length
  ) {
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
    if (allowedToSend <= 0)
      debug('Waiting before sending next message', {
        ...logCtx,
        sendFrequency,
      });
    while (allowedToSend <= 0) await sleep(1000);
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
    updateWalletBalanceMetricFor(app, origin).catch((e) => {
      warn('Failed to update wallet balance for chain', {
        chain: origin,
        err: format(e),
      });
    });

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
  let value = await gasCalc.estimatePaymentForHandleGas(
    origin,
    destination,
    expectedHandleGas,
  );
  const metricLabels = { origin, remote: destination };

  log('Sending message', {
    origin,
    destination,
    interchainGasPayment: value.toString(),
  });

  // For now, pay just 1 wei, as Kathy typically doesn't have enough
  // funds to send from a cheap chain to expensive chains like Ethereum.
  //
  // TODO remove this once the Kathy key is funded with a higher
  // balance and interchain gas payments are cycled back into
  // the funder frequently.
  value = BigNumber.from(1);
  // Log it as an obvious reminder
  log('Intentionally setting interchain gas payment to 1');

  const channelStatsBefore = await app.channelStats(origin, destination);
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

  try {
    await utils.timeout(
      app.waitForMessageReceipt(receipt),
      MESSAGE_RECEIPT_TIMEOUT,
      'Timeout waiting for message to be received',
    );
  } catch (error) {
    // If we weren't able to get the receipt for message processing, try to read the state to ensure it wasn't a transient provider issue
    const channelStatsNow = await app.channelStats(origin, destination);
    if (channelStatsNow.received <= channelStatsBefore.received) {
      log("Did not receive event for message delivery even though it was delivered", {origin, destination})
      throw error;
    }
  }

  messageReceiptSeconds
    .labels(metricLabels)
    .inc((Date.now() - startTime) / 1000);
  log('Message received', {
    origin,
    destination,
  });
}

async function updateWalletBalanceMetricFor(
  app: HelloWorldApp<any>,
  chain: ChainName,
): Promise<void> {
  const provider = app.multiProvider.getChainConnection(chain).provider;
  const signerAddress = await app
    .getContracts(chain)
    .router.signer.getAddress();
  const signerBalance = await provider.getBalance(signerAddress);
  const balance = parseFloat(ethers.utils.formatEther(signerBalance));
  walletBalance
    .labels({
      chain,
      // this address should not have the 0x prefix and should be all lowercase
      wallet_address: signerAddress.toLowerCase().slice(2),
      wallet_name: 'kathy',
      token_address: 'none',
      token_name: 'Native',
      token_symbol: 'Native',
    })
    .set(balance);
  debug('Wallet balance updated for chain', { chain, signerAddress, balance });
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
