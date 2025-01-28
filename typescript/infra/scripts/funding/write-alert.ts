import { checkbox } from '@inquirer/prompts';
import yargs from 'yargs';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { AlertType, alertConfigMapping } from '../../config/grafanaAlerts.js';
import { readJSONAtPath } from '../../src/utils/utils.js';
import { withAlertType, withConfirmAllChoices } from '../agent-utils.js';

import {
  THRESHOLD_CONFIG_PATH,
  fetchGrafanaAlert,
  fetchServiceAccountToken,
  generateQuery,
  updateGrafanaAlert,
} from './utils/grafana.js';

async function main() {
  const { alertType, all } = await withConfirmAllChoices(
    withAlertType(yargs(process.argv.slice(2))),
  ).argv;

  const saToken = await fetchServiceAccountToken();

  const alertsToUpdate: AlertType[] = all
    ? Object.values(AlertType)
    : alertType
    ? [alertType]
    : await checkbox({
        message: 'Select the alert type to update',
        choices: Object.values(AlertType).map((alert) => ({
          name: alertConfigMapping[alert].choiceLabel,
          value: alert,
          checked: true, // default to all checked
        })),
      });

  for (const alert of alertsToUpdate) {
    // fetch alertRule config from Grafana
    const alertRule = await fetchGrafanaAlert(alert, saToken);

    let thresholds: ChainMap<string> = {};
    try {
      thresholds = readJSONAtPath(
        `${THRESHOLD_CONFIG_PATH}/${alertConfigMapping[alert].configFileName}`,
      );
    } catch (e) {
      rootLogger.error(`Error reading ${alert} config: ${e}`);
      process.exit(1);
    }

    const query = generateQuery(alert, thresholds);

    // only change the query
    await updateGrafanaAlert(
      alertConfigMapping[alert].grafanaAlertId,
      alertRule.rawData,
      query,
      saToken,
    );

    rootLogger.info(`Updated ${alert} alert`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
