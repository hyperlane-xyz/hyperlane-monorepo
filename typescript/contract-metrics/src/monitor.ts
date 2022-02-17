import { OpticsContext } from '@abacus-network/sdk';
import config from './config';
import * as contexts from './registerContext';
import { monitorCore } from './monitor/core';
import { monitorGovernance } from './monitor/governance';

const cliArgs = process.argv.slice(2);

switch (cliArgs[0]) {
  case 'once':
    main(false);
    break;

  default:
    main(true);
    break;
}

async function main(forever: boolean) {
  if (forever) {
    config.metrics.startServer(9090);
  }
  do {
    await monitorAll();
    if (forever) {
      config.baseLogger.info('Sleeping for 120 seconds.');
      await new Promise((resolve) => setTimeout(resolve, 120000));
    }
  } while (forever);
}

async function monitorAll() {
  const context =
    config.environment == 'mainnet' ? contexts.mainnet : contexts.dev;

  await monitorGovernor(context);
  for (let network of config.networks) {
    const origin = network;
    const remotes = config.networks.filter((m) => m != origin);
    try {
      await monitorCore(context, origin, remotes);
    } catch (e) {
      config.baseLogger.error(
        { error: e },
        `Encountered an Error while processing ${origin}!`,
      );
      continue;
    }
  }
}

async function monitorGovernor(context: OpticsContext) {
  await monitorGovernance(context, await context.governorDomain());
}
