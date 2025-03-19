import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

import { THRESHOLD_CONFIG_PATH } from '../../src/config/funding/balances.js';
import { alertConfigMapping } from '../../src/config/funding/grafanaAlerts.js';
import { getBalanceAlertThresholds } from '../../src/funding/alerts.js';
import { sortThresholds } from '../../src/funding/balances.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';
import { withAlertTypeRequired, withWrite } from '../agent-utils.js';

// this scripts reads the thresholds in the grafana alert, prints and then overwrites the thresholds in the file
// it has been helpful in debugging and updating the thresholds during the development phase to reset the thresholds
// it is not intended to be used in the production process of managing the thresholds
async function main() {
  const { alertType, write } = await withWrite(
    withAlertTypeRequired(yargs(process.argv.slice(2))),
  ).argv;

  const alertThresholds = await getBalanceAlertThresholds(alertType);
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
