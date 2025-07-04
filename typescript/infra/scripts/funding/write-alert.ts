import { confirm } from '@inquirer/prompts';
import { ChildProcess } from 'child_process';
import yargs from 'yargs';

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
  ProvisionedAlertRule,
  alertConfigMapping,
} from '../../src/config/funding/grafanaAlerts.js';
import { parseBalancesPromQLQuery } from '../../src/funding/alerts.js';
import { validateThresholds } from '../../src/funding/balances.js';
import {
  fetchGrafanaAlert,
  fetchGrafanaServiceAccountToken,
  generateQuery,
  updateGrafanaAlert,
} from '../../src/infrastructure/monitoring/grafana.js';
import {
  LOCAL_PROM_URL,
  PROMETHEUS_LOCAL_PORT,
  fetchPrometheusInstantExpression,
  portForwardPrometheusServer,
} from '../../src/infrastructure/monitoring/prometheus.js';
import { readJSONAtPath } from '../../src/utils/utils.js';
import { withDryRun } from '../agent-utils.js';

interface AlertUpdateInfo {
  alertType: AlertType;
  grafanaAlertId: string;
  provisionedAlertRule: ProvisionedAlertRule;
  query: string;
}

interface RegressionError {
  alertType: AlertType;
  missingChains: string[];
}

async function main() {
  const { dryRun } = await withDryRun(yargs(process.argv.slice(2))).argv;

  const confirmed = await confirm({
    message:
      'Before proceeding, please ensure that any threshold changes have been committed and reviewed in a PR, have all changes been reviewed?',
  });

  if (!confirmed) {
    rootLogger.info('Exiting without updating any alerts');
    process.exit(0);
  }

  // runs a validation check to ensure the threshold configs are valid relative to each other
  await validateBalanceThresholdConfigs();

  const saToken = await fetchGrafanaServiceAccountToken();
  const portForwardProcess = await portForwardPrometheusServer(
    PROMETHEUS_LOCAL_PORT,
  );

  process.on('SIGINT', () => {
    cleanUp(portForwardProcess);
    process.exit(1);
  });

  process.on('beforeExit', () => {
    cleanUp(portForwardProcess);
  });

  try {
    const alertsToUpdate = Object.values(AlertType);
    const alertUpdateInfo: AlertUpdateInfo[] = [];
    const missingChainErrors: RegressionError[] = [];

    for (const alert of alertsToUpdate) {
      // fetch alertRule config from Grafana via the Grafana API
      const alertRule = await fetchGrafanaAlert(alert, saToken);

      // read the proposed thresholds from the config file
      let proposedThresholds: ChainMap<number> = {};
      proposedThresholds = readJSONAtPath(
        `${THRESHOLD_CONFIG_PATH}/${alertConfigMapping[alert].configFileName}`,
      );

      // parse the current thresholds from the existing query
      const existingQuery = alertRule.queries[0];
      const currentThresholds = parseBalancesPromQLQuery(
        existingQuery,
        alertConfigMapping[alert].walletName,
      );

      // log an error if a chain is defined in current thresholds but not in the proposed thresholds
      // this is to ensure that we don't introduce a regression where a chain is no longer being monitored
      const missingChains = Object.keys(currentThresholds).filter(
        (chain) => !proposedThresholds[chain],
      );
      if (missingChains.length > 0) {
        missingChainErrors.push({
          alertType: alert,
          missingChains,
        });
      }

      // generate a table of the differences in the thresholds, prompt the user to confirm the changes
      const diffTable = generateDiffTable(
        currentThresholds,
        proposedThresholds,
      );
      if (diffTable.length > 0) {
        rootLogger.info(`Differences in ${alert} thresholds:`);
        console.table(diffTable);

        const confirmed = await confirm({
          message: `Do you want to update thresholds for ${alert}?`,
        });

        if (!confirmed) {
          rootLogger.info(
            `Exiting without updating any alerts, this is to avoid thresholds from being out of sync`,
          );
          cleanUp(portForwardProcess);
          process.exit(0);
        }
      } else {
        rootLogger.info(
          `Proposed thresholds for ${alert} are the same as existing thresholds, skipping`,
        );
        continue;
      }

      // prompt the user to confirm that they are ok with the alert firing for chains after the update
      const query = generateQuery(alert, proposedThresholds);
      await confirmFiringAlerts(
        alert,
        query,
        currentThresholds,
        proposedThresholds,
        portForwardProcess,
      );

      alertUpdateInfo.push({
        alertType: alert,
        grafanaAlertId: alertConfigMapping[alert].grafanaAlertId,
        provisionedAlertRule: alertRule.rawData,
        query,
      });
    }

    // abort if there are any missing thresholds in the config to avoid introducing a regression
    await handleMissingChainErrors(missingChainErrors);

    if (!dryRun) {
      // update the alerts with the new thresholds via the Grafana API
      await updateAlerts(alertUpdateInfo, saToken, portForwardProcess);
    } else {
      rootLogger.info('Dry run, not updating alerts');
    }
  } finally {
    cleanUp(portForwardProcess);
  }
}

async function validateBalanceThresholdConfigs() {
  const balanceThresholdTypes = Object.values(BalanceThresholdType);
  const balanceThresholdConfigs = balanceThresholdTypes.reduce(
    (acc, balanceThresholdType) => {
      const thresholds = readJSONAtPath(
        `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[balanceThresholdType].configFileName}`,
      ) as ChainMap<string>;

      return {
        ...acc,
        [balanceThresholdType]: thresholds,
      };
    },
    {} as ThresholdsData,
  );

  validateThresholds(balanceThresholdConfigs);
}

async function fetchFiringThresholdAlert(query: string): Promise<string[]> {
  const results = await fetchPrometheusInstantExpression(LOCAL_PROM_URL, query);

  const alertingChains: string[] = [];

  for (const series of results) {
    const chain = series.metric.chain;

    if (series.value && parseFloat(series.value[1]) < 0) {
      alertingChains.push(chain);
    } else if (series.histogram) {
      rootLogger.warn(
        `Unexpected histogram data found for "${chain} in Prometheus, skipping.`,
      );
    }
  }

  return alertingChains;
}

async function updateAlerts(
  alertUpdateInfo: AlertUpdateInfo[],
  saToken: string,
  portForwardProcess: ChildProcess,
) {
  // sort alertUpdateInfo by alertConfigMapping writePriority in descending order
  // the intention is to update alerts with higher writePriority first
  // if there are any errors, we don't want to continue updating alert thresholds with lower writePriority
  // to avoid the thresholds being out of sync, this is only effective when we are increasing thresholds which is the most common case
  alertUpdateInfo.sort(
    (a, b) =>
      alertConfigMapping[b.alertType].writePriority -
      alertConfigMapping[a.alertType].writePriority,
  );

  for (const alertInfo of alertUpdateInfo) {
    try {
      await updateGrafanaAlert(
        alertInfo.grafanaAlertId,
        alertInfo.provisionedAlertRule,
        alertInfo.query,
        saToken,
      );
      rootLogger.info(`Updated ${alertInfo.alertType} alert`);
    } catch (e) {
      rootLogger.error(
        `Error updating ${alertInfo.alertType} alert, aborting updating the rest of the alerts: ${e}`,
      );
      // exiting here so we don't continue updating alerts with lower writePriority
      cleanUp(portForwardProcess);
      process.exit(1);
    }
  }
}

function generateDiffTable(
  currentThresholds: ChainMap<number>,
  proposedThresholds: ChainMap<number>,
) {
  const diffTable = [];

  // Check for changes and additions
  for (const [chain, newThreshold] of Object.entries(proposedThresholds)) {
    const currentThreshold = currentThresholds[chain];
    if (currentThreshold !== newThreshold) {
      diffTable.push({
        chain,
        current: currentThreshold,
        new: newThreshold,
        change:
          currentThreshold === undefined
            ? 'new'
            : currentThreshold < newThreshold
              ? 'increase'
              : 'decrease',
      });
    }
  }

  // Check for removals
  for (const chain of Object.keys(currentThresholds)) {
    if (!(chain in proposedThresholds)) {
      diffTable.push({
        chain,
        current: currentThresholds[chain],
        new: undefined,
        change: 'removed',
      });
    }
  }

  return diffTable;
}

async function handleMissingChainErrors(missingChainErrors: RegressionError[]) {
  if (missingChainErrors.length === 0) return;

  for (const error of missingChainErrors) {
    for (const chain of error.missingChains) {
      const confirmed = await confirm({
        message: `Is the missing chain "${chain}" for ${error.alertType} expected?`,
        default: false,
      });

      if (!confirmed) {
        rootLogger.error(
          `Aborting updating alerts due to unexpected missing chain: ${chain} for ${error.alertType}`,
        );
        process.exit(1);
      }
    }
  }

  rootLogger.info(
    'Proceeding with alert updates - all missing chains confirmed as expected',
  );
}

async function confirmFiringAlerts(
  alert: AlertType,
  query: string,
  currentThresholds: ChainMap<number>,
  proposedThresholds: ChainMap<number>,
  portForwardProcess: ChildProcess,
) {
  const alertingChains = await fetchFiringThresholdAlert(query);
  if (alertingChains.length === 0) return;

  rootLogger.warn(
    `updating ${alert} alert will result in alerting for the following chains`,
  );
  console.table(
    alertingChains.map((chain) => ({
      chain,
      current: currentThresholds[chain],
      proposed: proposedThresholds[chain],
    })),
  );

  const confirmed = await confirm({
    message: `Do you want to proceed with updating the alert thresholds for ${alert}?`,
  });
  if (!confirmed) {
    rootLogger.info(
      `Exiting without updating any alerts, this is to avoid thresholds from being out of sync as we do not want to update the ${alert} alert`,
    );
    cleanUp(portForwardProcess);
    process.exit(0);
  }
}

function cleanUp(portForwardProcess: ChildProcess) {
  if (!portForwardProcess.killed) {
    rootLogger.info('Cleaning up port forward process');
    portForwardProcess.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
