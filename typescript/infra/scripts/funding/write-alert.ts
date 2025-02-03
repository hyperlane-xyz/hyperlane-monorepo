import { checkbox } from '@inquirer/prompts';
import yargs from 'yargs';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { THRESHOLD_CONFIG_PATH } from '../../src/config/funding/balances.js';
import {
  AlertType,
  alertConfigMapping,
} from '../../src/config/funding/grafanaAlerts.js';
import {
  fetchGrafanaAlert,
  fetchServiceAccountToken,
  generateQuery,
  updateGrafanaAlert,
} from '../../src/funding/grafana.js';
import { readJSONAtPath } from '../../src/utils/utils.js';
import { withAlertType, withConfirmAllChoices } from '../agent-utils.js';

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
