import { BigNumber, ethers } from 'ethers';
import { Counter, Gauge, Registry } from 'prom-client';
import { format } from 'util';

import { HelloWorldApp } from '@hyperlane-xyz/helloworld';
import {
  ChainName,
  DispatchedMessage,
  HyperlaneCore,
  InterchainGasCalculator,
} from '@hyperlane-xyz/sdk';
import { debug, error, log, utils, warn } from '@hyperlane-xyz/utils';

import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { ConnectionType } from '../../src/config/agent';
import { deployEnvToSdkEnv } from '../../src/config/environment';
import { startMetricsServer } from '../../src/utils/metrics';
import { assertChain, diagonalize, sleep } from '../../src/utils/utils';
import { getArgsWithContext, getCoreEnvironmentConfig } from '../utils';

import { getApp } from './utils';

const metricsRegister = new Registry();
// TODO rename counter names
const messagesSendCount = new Counter({
  name: 'hyperlane_kathy_messages',
  help: 'Count of messages sent; records successes and failures by status label',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote', 'status'],
});
const currentPairingIndexGauge = new Gauge({
  name: 'hyperlane_kathy_pairing_index',
  help: 'The current message pairing index kathy is on, this is useful for seeing if kathy is always crashing around the same pairing as pairings are deterministically ordered.',
  registers: [metricsRegister],
  labelNames: [],
});
const messageSendSeconds = new Counter({
  name: 'hyperlane_kathy_message_send_seconds',
  help: 'Total time spent waiting on messages to get sent not including time spent waiting on it to be received.',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote'],
});
const messageReceiptSeconds = new Counter({
  name: 'hyperlane_kathy_message_receipt_seconds',
  help: 'Total time spent waiting on messages to be received including time to be sent.',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote'],
});
const walletBalance = new Gauge({
  name: 'hyperlane_wallet_balance',
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

/** The maximum number of messages we will allow to get queued up if we are sending too slowly. */
const MAX_MESSAGES_ALLOWED_TO_SEND = 5;

function getKathyArgs() {
  const args = getArgsWithContext()
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
    .demandOption('chains-to-skip')
    .coerce('chains-to-skip', (chainStrs: string[]) =>
      chainStrs.map((chainStr: string) => assertChain(chainStr)),
    )

    .string('connection-type')
    .describe('connection-type', 'The provider connection type to use for RPCs')
    .default('connection-type', ConnectionType.Http)
    .choices('connection-type', [
      ConnectionType.Http,
      ConnectionType.HttpQuorum,
      ConnectionType.HttpFallback,
    ])
    .demandOption('connection-type');

  // Splitting these args from the rest of them because TypeScript otherwise
  // complains that the "Type instantiation is excessively deep and possibly infinite."
  return args
    .number('cycles-between-ethereum-messages')
    .describe(
      'cycles-between-ethereum-messages',
      'How many cycles to skip between a cycles that send messages to/from Ethereum',
    )
    .default('cycles-between-ethereum-messages', 0).argv;
}

// Returns whether an error occurred
async function main(): Promise<boolean> {
  const {
    environment,
    context,
    chainsToSkip,
    cycleOnce,
    fullCycleTime,
    messageSendTimeout,
    messageReceiptTimeout,
    connectionType,
    cyclesBetweenEthereumMessages,
  } = await getKathyArgs();

  let errorOccurred = false;

  startMetricsServer(metricsRegister);
  debug('Starting up', { environment });

  const coreConfig = getCoreEnvironmentConfig(environment);
  const app = await getApp(
    coreConfig,
    context,
    KEY_ROLE_ENUM.Kathy,
    undefined,
    connectionType,
  );
  const gasCalculator = InterchainGasCalculator.fromEnvironment(
    deployEnvToSdkEnv[environment],
    app.multiProvider,
  );
  const appChains = app.chains();

  // Ensure the specified chains to skip are actually valid for the app.
  // Despite setting a default and demanding it as an option, yargs believes
  // chainsToSkip can possibly be undefined.
  for (const chainToSkip of chainsToSkip!) {
    if (!appChains.includes(chainToSkip)) {
      throw Error(
        `Chain to skip ${chainToSkip} invalid, not found in ${appChains}`,
      );
    }
  }

  const chains = appChains.filter(
    (chain) => !chainsToSkip || !chainsToSkip.includes(chain),
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

  if (cycleOnce) {
    // If we're cycling just once, we're allowed to send all the pairings
    allowedToSend = pairings.length;
    // Start with pairing 0
    currentPairingIndex = 0;

    debug('Cycling once through all pairs');
  } else {
    // If we are not cycling just once and are running this as a service, do so at an interval.
    // Track how many we are still allowed to send in case some messages send slower than expected.
    allowedToSend = 1;
    sendFrequency = fullCycleTime / pairings.length;
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

  chains.map((chain) => updateWalletBalanceMetricFor(app, chain));

  // Incremented each time an entire cycle has occurred
  let currentCycle = 0;
  // Within the current cycle, how many messages have been sent
  let cycleMessageCount = 0;

  // Use to move to the next message in a cycle.
  // Returns true if we should stop sending messages.
  const nextMessage = async () => {
    // If it's the end of a cycle...
    if (cycleMessageCount == pairings.length - 1) {
      // Print stats
      for (const [origin, destinationStats] of Object.entries(
        await app.stats(),
      )) {
        for (const [destination, counts] of Object.entries(destinationStats)) {
          debug('Message stats', {
            origin,
            destination,
            currentCycle,
            ...counts,
          });
        }
      }
      // Move to the next cycle and reset the # of messages in the cycle
      currentCycle++;
      cycleMessageCount = 0;

      if (cycleOnce) {
        log('Finished cycling through all pairs once');
        // Return true to signify messages should stop being sent.
        return true;
      }
    } else {
      cycleMessageCount++;
    }

    // Move on to the next index
    currentPairingIndex = (currentPairingIndex + 1) % pairings.length;
    // Return false to signify messages should continue to be sent.
    return false;
  };

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

    // Skip Ethereum if we've been configured to do so for this cycle
    if (
      (origin === 'ethereum' || destination === 'ethereum') &&
      currentCycle % (cyclesBetweenEthereumMessages + 1) !== 0
    ) {
      debug('Skipping message to/from Ethereum', {
        currentCycle,
        origin,
        destination,
        cyclesBetweenEthereumMessages,
      });
      // Break if we should stop sending messages
      if (await nextMessage()) {
        break;
      }
      // Move to the next message
      continue;
    }

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
      await sendMessage(
        app,
        origin,
        destination,
        gasCalculator,
        messageSendTimeout,
        messageReceiptTimeout,
      );
      log('Message sent successfully', { origin, destination });
      messagesSendCount.labels({ ...labels, status: 'success' }).inc();
    } catch (e) {
      error(`Error sending message, continuing...`, {
        error: format(e),
        ...logCtx,
      });
      messagesSendCount.labels({ ...labels, status: 'failure' }).inc();
      errorOccurred = true;
    }
    updateWalletBalanceMetricFor(app, origin).catch((e) => {
      warn('Failed to update wallet balance for chain', {
        chain: origin,
        err: format(e),
      });
    });

    // Break if we should stop sending messages
    if (await nextMessage()) {
      break;
    }
  }
  return errorOccurred;
}

async function sendMessage(
  app: HelloWorldApp,
  origin: ChainName,
  destination: ChainName,
  gasCalc: InterchainGasCalculator,
  messageSendTimeout: number,
  messageReceiptTimeout: number,
) {
  const startTime = Date.now();
  const msg = 'Hello!';
  const expectedHandleGas = BigNumber.from(100_000);

  const value = await utils.retryAsync(
    () =>
      gasCalc.quoteGasPaymentForDefaultIsmIgp(
        origin,
        destination,
        expectedHandleGas,
      ),
    2,
  );
  const metricLabels = { origin, remote: destination };

  log('Sending message', {
    origin,
    destination,
    interchainGasPayment: value.toString(),
  });

  const receipt = await utils.retryAsync(
    () =>
      utils.timeout(
        app.sendHelloWorld(origin, destination, msg, value),
        messageSendTimeout,
        'Timeout sending message',
      ),
    2,
  );
  messageSendSeconds.labels(metricLabels).inc((Date.now() - startTime) / 1000);

  const [message] = app.core.getDispatchedMessages(receipt);
  log('Message sent', {
    origin,
    destination,
    events: receipt.events,
    logs: receipt.logs,
    message,
  });

  try {
    await utils.timeout(
      app.waitForMessageProcessed(receipt),
      messageReceiptTimeout,
      'Timeout waiting for message to be received',
    );
  } catch (error) {
    // If we weren't able to get the receipt for message processing,
    // try to read the state to ensure it wasn't a transient provider issue
    log('Checking if message was received despite timeout', {
      message,
    });

    // Try a few times to see if the message has been processed --
    // we've seen some intermittent issues when fetching state.
    // This will throw if the message is found to have not been processed.
    await utils.retryAsync(async () => {
      if (!(await messageIsProcessed(app.core, origin, destination, message))) {
        throw error;
      }
    }, 3);

    // Otherwise, the message has been processed
    log(
      'Did not receive event for message delivery even though it was delivered',
      { origin, destination, message },
    );
  }

  messageReceiptSeconds
    .labels(metricLabels)
    .inc((Date.now() - startTime) / 1000);
  log('Message received', {
    origin,
    destination,
  });
}

async function messageIsProcessed(
  core: HyperlaneCore,
  origin: ChainName,
  destination: ChainName,
  message: DispatchedMessage,
): Promise<boolean> {
  const destinationMailbox = core.getContracts(destination).mailbox.contract;
  return destinationMailbox.delivered(message.id);
}

async function updateWalletBalanceMetricFor(
  app: HelloWorldApp,
  chain: ChainName,
): Promise<void> {
  const provider = app.multiProvider.getProvider(chain);
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
  .then((errorOccurred: boolean) => {
    log('Main exited');
    if (errorOccurred) {
      error('An error occurred at some point');
      process.exit(1);
    } else {
      process.exit(0);
    }
  })
  .catch((e) => {
    error('Error in main', { error: format(e) });
    process.exit(1);
  });
