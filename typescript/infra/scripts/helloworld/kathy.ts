import { ethers } from 'ethers';
import { Counter, Gauge, Registry } from 'prom-client';

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
  help: 'Whether messages which have been sent from one chain to another successfully; will report 0 for unsuccessful and 1 for successful.',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote', 'status'],
});
const currentPairingIndexGauge = new Gauge({
  name: 'abacus_kathy_pairing_index',
  help: 'The current message pairing index kathy is on, this is useful for seeing if kathy is always crashing around the same pairing as pairings are deterministically ordered.',
  registers: [metricsRegister],
  labelNames: [],
});
metricsRegister.registerMetric(messagesSendCount);
metricsRegister.registerMetric(currentPairingIndexGauge);

async function main() {
  startMetricsServer(metricsRegister);
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const app = await getApp(coreConfig);
  const gasCalc = InterchainGasCalculator.fromEnvironment(
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
    origins.map((source) =>
      origins.map((destination) =>
        source == destination ? null : { source, destination },
      ),
    ),
  )
    .filter((v) => v !== null)
    .map((v) => v!);

  // default to once every 6 hours getting through all pairs
  const fullCycleTime = process.env['KATHY_FULL_CYCLE_TIME']
    ? parseInt(process.env['KATHY_FULL_CYCLE_TIME'])
    : 1000 * 60 * 60 * 6;
  if (!Number.isSafeInteger(fullCycleTime) || fullCycleTime <= 0) {
    error('Invalid cycle time provided');
    process.exit(1);
  }

  // track how many we are still allowed to send in case some messages send slower than expected.
  let allowedToSend = 0;
  setInterval(() => {
    allowedToSend++;
  }, fullCycleTime / pairings.length);

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

    const { source, destination } = pairings[currentPairingIndex];
    const labels = {
      origin: source,
      remote: destination,
    };
    try {
      await sendMessage(app, source, destination, gasCalc);
      log('Message sent successfully', { from: source, to: destination });
      messagesSendCount.labels({ ...labels, status: 'success' }).inc();
    } catch (e) {
      error(`Error sending message, continuing...`, {
        error: e,
        from: source,
        to: destination,
      });
      messagesSendCount.labels({ ...labels, status: 'failure' }).inc();
    }

    // print stats once every cycle through the pairings
    if (currentPairingIndex == 0) {
      for (const [from, destinationStats] of Object.entries(
        await app.stats(),
      )) {
        for (const [to, counts] of Object.entries(destinationStats)) {
          debug('Message stats', { from, to, ...counts });
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
  const msg = 'Hello!';
  const expected = {
    origin,
    destination,
    sender: app.getContracts(origin).router.address,
    recipient: app.getContracts(destination).router.address,
    body: msg,
  };
  const value = await gasCalc.estimatePaymentForMessage(expected);

  log('Sending message', { from: origin, to: destination });

  await new Promise<ethers.ContractReceipt[]>((resolve, reject) => {
    setTimeout(
      () => reject(new Error('Timeout waiting for message receipt')),
      10 * 60 * 1000,
    );
    app
      .sendHelloWorld(origin, destination, msg, value, (receipt) => {
        log('Message sent', {
          from: origin,
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
