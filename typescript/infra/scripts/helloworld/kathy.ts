import { BigNumber } from 'ethers';
import { Gauge, Registry } from 'prom-client';

import { HelloWorldApp } from '@abacus-network/helloworld';
import {
  AbacusCore,
  ChainName,
  Chains,
  InterchainGasCalculator,
} from '@abacus-network/sdk';

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
  const multiProvider = await coreConfig.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);
  const gasCalc = InterchainGasCalculator.fromEnvironment(
    environment,
    multiProvider as any,
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

  let failureOccurred = false;

  const origins = chains.filter((chain) => !skip || !skip.includes(chain));

  // submit frequently so we don't have to wait a super long time for info to get into the metrics
  const metricsInterval = setInterval(() => {
    submitMetrics(metricsRegister, 'kathy', { appendMode: true }).catch(
      console.error,
    );
  }, 1000 * 30);

  for (const origin of origins) {
    for (const destination of origins.filter((d) => d !== origin)) {
      const labels = {
        origin,
        remote: destination,
        ...constMetricLabels,
      };
      try {
        await sendMessage(app, origin, destination, gasCalc);
        messagesSendStatus.labels({ ...labels }).set(1);
      } catch (err) {
        console.error(
          `Error sending message from ${origin} to ${destination}, continuing...`,
          `${err}`.replaceAll('\n', ' ## '),
        );
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
    console.error('Failure occurred at least once');
    process.exit(1);
  }
}

async function sendMessage(
  app: HelloWorldApp<any>,
  origin: ChainName,
  destination: ChainName,
  gasCalc: InterchainGasCalculator<any>,
) {
  const msg = 'Hello!';
  const expectedHandleGas = BigNumber.from(100_000);
  const value = await gasCalc.estimatePaymentForHandleGas(
    origin,
    destination,
    expectedHandleGas,
  );
  console.log(`Sending message from ${origin} to ${destination}`);
  const receipt = await app.sendHelloWorld(origin, destination, msg, value);
  console.log(JSON.stringify(receipt.events || receipt.logs));
}

main()
  .then(() => console.info('HelloWorld sent'))
  .catch(console.error);
