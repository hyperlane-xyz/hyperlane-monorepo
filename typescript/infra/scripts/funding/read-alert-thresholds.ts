import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

import { alertConfigMapping } from '../../config/grafanaAlerts.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';
import { withAlertTypeRequired, withWrite } from '../agent-utils.js';

import {
  THRESHOLD_CONFIG_PATH,
  getAlertThresholds,
  sortThresholds,
} from './utils/grafana.js';

async function main() {
  const { alertType, write } = await withWrite(
    withAlertTypeRequired(yargs(process.argv.slice(2))),
  ).argv;

  const alertThresholds = await getAlertThresholds(alertType);
  const sortedThresholds = sortThresholds(alertThresholds);

  console.table(sortedThresholds);

  if (write) {
    rootLogger.info('Writing alert thresholds to file..');
    try {
      writeJsonAtPath(
        `${THRESHOLD_CONFIG_PATH}/${alertConfigMapping[alertType].configFileName}`,
        sortedThresholds,
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
