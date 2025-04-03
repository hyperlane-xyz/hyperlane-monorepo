import { expect } from 'chai';

import { THRESHOLD_CONFIG_PATH } from '../src/config/funding/balances.js';
import {
  AlertType,
  alertConfigMapping,
} from '../src/config/funding/grafanaAlerts.js';
import { parseBalancesPromQLQuery } from '../src/funding/alerts.js';
import {
  fetchGrafanaAlert,
  fetchGrafanaServiceAccountToken,
} from '../src/infrastructure/monitoring/grafana.js';
import { readJSONAtPath } from '../src/utils/utils.js';

describe('Balance Alert Thresholds', () => {
  it('should have matching thresholds between Grafana alerts and threshold config files', async () => {
    const saToken = await fetchGrafanaServiceAccountToken();
    const alertsToCheck = Object.values(AlertType);
    const mismatches: string[] = [];

    for (const alert of alertsToCheck) {
      // Fetch alert rule from Grafana
      const alertRule = await fetchGrafanaAlert(alert, saToken);
      const existingQuery = alertRule.queries[0];

      // Parse current thresholds from the query
      const currentThresholds = parseBalancesPromQLQuery(
        existingQuery,
        alertConfigMapping[alert].walletName,
      );

      // Read proposed thresholds from config file
      const proposedThresholds = readJSONAtPath(
        `${THRESHOLD_CONFIG_PATH}/${alertConfigMapping[alert].configFileName}`,
      );

      // Compare thresholds
      const allChains = new Set([
        ...Object.keys(currentThresholds),
        ...Object.keys(proposedThresholds),
      ]);

      for (const chain of allChains) {
        const current = currentThresholds[chain];
        const proposed = proposedThresholds[chain];

        if (current !== proposed) {
          mismatches.push(
            `${alert} - ${chain}: current=${current}, proposed=${proposed}`,
          );
        }
      }
    }

    if (mismatches.length > 0) {
      expect.fail(
        'Found mismatches between Grafana alerts and config files:\n' +
          mismatches.join('\n'),
      );
    }
  });
});
