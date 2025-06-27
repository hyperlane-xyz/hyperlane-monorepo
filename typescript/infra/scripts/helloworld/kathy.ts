import { Keypair, sendAndConfirmRawTransaction } from '@solana/web3.js';
import { BigNumber, Wallet, ethers } from 'ethers';
import { Counter, Gauge, Registry } from 'prom-client';
import { format } from 'util';

import { HelloMultiProtocolApp } from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  ChainName,
  HyperlaneIgp,
  MultiProtocolCore,
  MultiProvider,
  ProviderType,
  TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  ensure0x,
  objMap,
  pick,
  retryAsync,
  rootLogger,
  sleep,
  strip0x,
  timeout,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import {
  hyperlaneHelloworld,
  releaseCandidateHelloworld,
} from '../../config/environments/testnet4/helloworld.js';
import { owners } from '../../config/environments/testnet4/owners.js';
import { CloudAgentKey } from '../../src/agents/keys.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { Role } from '../../src/roles.js';
import {
  getWalletBalanceGauge,
  startMetricsServer,
} from '../../src/utils/metrics.js';
import { assertChain, diagonalize } from '../../src/utils/utils.js';
import { getArgs, withContext } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

import { getHelloWorldMultiProtocolApp } from './utils.js';

const logger = rootLogger.child({ module: 'kathy' });

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
const walletBalance = getWalletBalanceGauge(metricsRegister);

/** The maximum number of messages we will allow to get queued up if we are sending too slowly. */
const MAX_MESSAGES_ALLOWED_TO_SEND = 5;

function getKathyArgs() {
  return withContext(getArgs())
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
    cyclesBetweenEthereumMessages,
  } = await getKathyArgs();

  let errorOccurred = false;

  startMetricsServer(metricsRegister);
  logger.debug('Starting up', { environment });

  const coreConfig = getEnvironmentConfig(environment);

  const { app, core, igp, multiProvider, keys } =
    await getHelloWorldMultiProtocolApp(
      coreConfig,
      context,
      Role.Kathy,
      undefined,
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

  logger.debug('Pairings calculated', { chains, pairings });

  let allowedToSend: number;
  let currentPairingIndex: number;
  let sendFrequency: number | undefined;

  if (cycleOnce) {
    // If we're cycling just once, we're allowed to send all the pairings
    allowedToSend = pairings.length;
    // Start with pairing 0
    currentPairingIndex = 0;

    logger.debug('Cycling once through all pairs');
  } else {
    // If we are not cycling just once and are running this as a service, do so at an interval.
    // Track how many we are still allowed to send in case some messages send slower than expected.
    allowedToSend = 1;
    sendFrequency = fullCycleTime / pairings.length;
    // in case we are restarting kathy, keep it from always running the exact same messages first
    currentPairingIndex = Date.now() % pairings.length;

    logger.debug('Running as a service', {
      sendFrequency,
    });

    setInterval(() => {
      // bucket cap since if we are getting really behind it probably does not make sense to let it run away.
      allowedToSend = Math.min(allowedToSend + 1, MAX_MESSAGES_ALLOWED_TO_SEND);
      logger.debug('Tick; allowed to send another message', {
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

  await Promise.all(
    chains.map(async (chain) => {
      return updateWalletBalanceMetricFor(
        app,
        chain,
        coreConfig.owners[chain].owner,
      );
    }),
  );

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
          logger.debug('Message stats', {
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
        logger.info('Finished cycling through all pairs once');
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
      logger.debug('Skipping message to/from Ethereum', {
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
      logger.debug('Waiting before sending next message', {
        ...logCtx,
        sendFrequency,
      });
      while (allowedToSend <= 0) await sleep(1000);
    }
    allowedToSend--;

    logger.debug('Initiating sending of new message', logCtx);

    try {
      await sendMessage(
        app,
        core,
        keys,
        multiProvider,
        igp,
        origin,
        destination,
        messageSendTimeout,
        messageReceiptTimeout,
      );
      logger.info('Message sent successfully', { origin, destination });
      messagesSendCount.labels({ ...labels, status: 'success' }).inc();
    } catch (e) {
      logger.error(`Error sending message, continuing...`, {
        error: format(e),
        ...logCtx,
      });
      messagesSendCount.labels({ ...labels, status: 'failure' }).inc();
      errorOccurred = true;
    }
    const owner = coreConfig.owners[origin].owner;
    updateWalletBalanceMetricFor(app, origin, owner).catch((e) => {
      logger.warn('Failed to update wallet balance for chain', {
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
  app: HelloMultiProtocolApp,
  core: MultiProtocolCore,
  keys: ChainMap<CloudAgentKey>,
  multiProvider: MultiProvider,
  igp: HyperlaneIgp,
  origin: ChainName,
  destination: ChainName,
  messageSendTimeout: number,
  messageReceiptTimeout: number,
) {
  const startTime = Date.now();
  const msg = 'Hello!';
  const expectedHandleGas = BigNumber.from(50_000);

  // TODO sealevel igp support here
  let value: string;
  if (app.metadata(origin).protocol == ProtocolType.Ethereum) {
    const valueBn = await retryAsync(
      () =>
        igp.quoteGasPaymentForDefaultIsmIgp(
          origin,
          destination,
          expectedHandleGas,
        ),
      2,
    );
    value = valueBn.toString();
  } else {
    value = '0';
  }

  const metricLabels = { origin, remote: destination };

  logger.info('Sending message', {
    origin,
    destination,
    interchainGasPayment: value,
  });

  const sendAndConfirmMsg = async () => {
    const originProtocol = app.metadata(origin).protocol;
    const sender = keys[origin].addressForProtocol(originProtocol);
    if (!sender) {
      throw new Error(
        `No sender address found for chain ${origin} and protocol ${originProtocol}`,
      );
    }
    const tx = await app.populateHelloWorldTx(
      origin,
      destination,
      msg,
      value,
      sender,
    );

    let txReceipt: TypedTransactionReceipt;
    if (tx.type == ProviderType.EthersV5) {
      // Utilize the legacy evm-specific multiprovider utils to send the transaction
      const receipt = await multiProvider.sendTransaction(
        origin,
        tx.transaction,
      );
      txReceipt = {
        type: ProviderType.EthersV5,
        hash: receipt.transactionHash,
        receipt,
      };
    } else if (tx.type === ProviderType.SolanaWeb3) {
      // Utilize the new multi-protocol provider for non-evm chains
      // This could be done for EVM too but the legacy MP has tx formatting utils
      // that have not yet been ported over
      const connection = app.multiProvider.getSolanaWeb3Provider(origin);
      const payer = Keypair.fromSeed(
        Buffer.from(strip0x(keys[origin].privateKey), 'hex'),
      );
      tx.transaction.partialSign(payer);
      // Note, tx signature essentially tx means hash on sealevel
      const txSignature = await sendAndConfirmRawTransaction(
        connection,
        tx.transaction.serialize(),
      );
      const receipt = await connection.getTransaction(txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!receipt)
        throw new Error(`Sealevel tx not found with signature ${txSignature}`);
      txReceipt = {
        type: ProviderType.SolanaWeb3,
        hash: '',
        receipt,
      };
    } else {
      throw new Error(`Unsupported provider type for kathy send ${tx.type}`);
    }
    return txReceipt;
  };

  const receipt = await retryAsync(
    () =>
      timeout(
        sendAndConfirmMsg(),
        messageSendTimeout,
        'Timeout sending message',
      ),
    2,
  );
  messageSendSeconds.labels(metricLabels).inc((Date.now() - startTime) / 1000);

  logger.info('Message sent, waiting for it to be processed', {
    origin,
    destination,
    receipt,
  });

  await timeout(
    // Retry indefinitely, but rely on the timeout to break out
    core.waitForMessagesProcessed(origin, destination, receipt, 5000),
    messageReceiptTimeout,
    'Timeout waiting for message to be received',
  );

  messageReceiptSeconds
    .labels(metricLabels)
    .inc((Date.now() - startTime) / 1000);
  logger.info('Message received', {
    origin,
    destination,
  });
}

async function updateWalletBalanceMetricFor(
  app: HelloMultiProtocolApp,
  chain: ChainName,
  signerAddress: Address,
): Promise<void> {
  if (app.metadata(chain).protocol !== ProtocolType.Ethereum) return;
  const provider = app.multiProvider.getEthersV5Provider(chain);
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
  logger.debug('Wallet balance updated for chain', {
    chain,
    signerAddress,
    balance,
  });
}

// Get a core config intended for testing Kathy without secret access
export async function getCoreConfigStub(environment: DeployEnvironment) {
  const environmentConfig = getEnvironmentConfig(environment);
  // Don't fetch any secrets.
  const registry = await environmentConfig.getRegistry(false);
  const testnetConfigs = pick(
    await registry.getMetadata(),
    environmentConfig.supportedChainNames,
  );
  const multiProvider = new MultiProvider({
    // Desired chains here. Key must have funds on these chains
    ...testnetConfigs,
    // solanadevnet: chainMetadata.solanadevnet,
  });

  const privateKeyEvm = process.env.KATHY_PRIVATE_KEY_EVM;
  if (!privateKeyEvm) throw new Error('KATHY_PRIVATE_KEY_EVM env var not set');
  const evmSigner = new Wallet(privateKeyEvm);
  logger.info('evmSigner address', evmSigner.address);
  multiProvider.setSharedSigner(evmSigner);

  // const privateKeySealevel = process.env.KATHY_PRIVATE_KEY_SEALEVEL;
  // if (!privateKeySealevel)
  //   throw new Error('KATHY_PRIVATE_KEY_SEALEVEL env var not set');

  // const sealevelSigner = Keypair.fromSeed(
  //   Buffer.from(privateKeySealevel, 'hex'),
  // );
  // console.logger.info('sealevelSigner address', sealevelSigner.publicKey.toBase58());

  const testnetKeys = objMap(testnetConfigs, (_, __) => ({
    address: evmSigner.address,
    privateKey: ensure0x(privateKeyEvm),
  }));

  return {
    helloWorld: {
      [Contexts.Hyperlane]: hyperlaneHelloworld,
      [Contexts.ReleaseCandidate]: releaseCandidateHelloworld,
    },
    environment,
    owners: owners,
    getMultiProvider: () => multiProvider,
    getKeys: () => testnetKeys,
  } as any;
}

main()
  .then((errorOccurred: boolean) => {
    logger.info('Main exited');
    if (errorOccurred) {
      logger.error('An error occurred at some point');
      process.exit(1);
    } else {
      process.exit(0);
    }
  })
  .catch((e) => {
    logger.error('Error in main', { error: format(e) });
    process.exit(1);
  });
