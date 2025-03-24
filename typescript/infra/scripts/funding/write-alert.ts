import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  BalanceThresholdType,
  THRESHOLD_CONFIG_PATH,
  ThresholdsData,
  balanceThresholdConfigMapping,
} from '../../src/config/funding/balances.js';
import {
  AlertType,
  alertConfigMapping,
} from '../../src/config/funding/grafanaAlerts.js';
import { validateThresholds } from '../../src/funding/balances.js';
import {
  fetchGrafanaAlert,
  fetchGrafanaServiceAccountToken,
  generateQuery,
  updateGrafanaAlert,
} from '../../src/infrastructure/monitoring/grafana.js';
import { readJSONAtPath } from '../../src/utils/utils.js';

async function main() {
  const saToken = await fetchGrafanaServiceAccountToken();

  const balanceThresholdTypes = Object.values(BalanceThresholdType);
  const balanceThresholdConfigs: ThresholdsData = balanceThresholdTypes.reduce(
    (acc, balanceThresholdType) => {
      const thresholds = readJSONAtPath(
        `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[balanceThresholdType].configFileName}`,
      ) as ChainMap<string>;

      return {
        ...acc,
        [balanceThresholdType]: {
          thresholds,
        },
      };
    },
    {} as ThresholdsData,
  );

  validateThresholds(balanceThresholdConfigs);

  const alertsToUpdate = Object.values(AlertType);

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
