import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

import { writeJsonAtPath } from '../../src/utils/utils.js';
import { withAlertType, withWrite } from '../agent-utils.js';

import {
  THRESHOLD_CONFIG_PATH,
  alertConfigMapping,
  getAlertThresholds,
} from './utils/grafana.js';

async function main() {
  const { alertType, write } = await withWrite(
    withAlertType(yargs(process.argv.slice(2))),
  ).argv;

  const alertThresholds = await getAlertThresholds(alertType);

  const alertThresholdArray = Object.entries(alertThresholds).map(
    ([chain, threshold]) => ({
      chain,
      threshold,
    }),
  );
  console.table(alertThresholdArray);

  if (write) {
    rootLogger.info('Writing alert thresholds to file..');
    try {
      writeJsonAtPath(
        `${THRESHOLD_CONFIG_PATH}/${alertConfigMapping[alertType].configFileName}`,
        alertThresholds,
      );
      rootLogger.info('Alert thresholds written to file.');
    } catch (e) {
      rootLogger.error('Error writing alert thresholds to file:', e);
    }
  }
}

main().catch((err) => {
  rootLogger.error(err);
  process.exit(1);
});
