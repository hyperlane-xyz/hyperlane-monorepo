import config from './config';
import { monitorCore } from './monitor/core';
import { monitorGovernance } from './monitor/governance';
import { core, governance } from './registerContext';

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
  await monitorGovernance(governance, config.networks);
  for (let network of config.networks) {
    const origin = network;
    const remotes = config.networks.filter((m) => m !== origin);
    try {
      // @ts-ignore
      await monitorCore(core, origin, remotes);
    } catch (e) {
      config.baseLogger.error(
        { error: e },
        `Encountered an Error while processing ${origin}!`,
      );
      continue;
    }
  }
}
