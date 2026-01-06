import chalk from 'chalk';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HelmManager, getHelmReleaseName } from '../../src/utils/helm.js';
import {
  WarpRouteMonitorHelmManager,
  getDeployedWarpMonitorWarpRouteIds,
} from '../../src/warp-monitor/helm.js';
import {
  assertCorrectKubeContext,
  getArgs,
  withWarpRouteId,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const orange = chalk.hex('#FFA500');
const GRAFANA_LINK =
  'https://abacusworks.grafana.net/d/ddz6ma94rnzswc/warp-routes?orgId=1&var-warp_route_id=';
const LOG_AMOUNT = 5;

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId } = await withWarpRouteId(getArgs()).argv;

  const config = getEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);

  let warpRouteIds: string[];
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    rootLogger.info(
      chalk.gray.italic(
        'No warp route ID specified, showing status for all deployed monitors...',
      ),
    );
    const deployedMonitors = await getDeployedWarpMonitorWarpRouteIds(
      environment,
      WarpRouteMonitorHelmManager.helmReleasePrefix,
    );
    warpRouteIds = deployedMonitors.map((m) => m.warpRouteId);
    rootLogger.info(
      chalk.gray(`Found ${warpRouteIds.length} deployed warp monitors\n`),
    );
  }

  for (const routeId of warpRouteIds) {
    await showWarpMonitorStatus(routeId, environment);
  }
}

async function showWarpMonitorStatus(warpRouteId: string, environment: string) {
  rootLogger.info(chalk.bold.blue(`\n${'='.repeat(60)}`));
  rootLogger.info(chalk.bold.blue(`Warp Monitor: ${warpRouteId}`));
  rootLogger.info(chalk.bold.blue(`${'='.repeat(60)}\n`));

  try {
    const podName = `${getHelmReleaseName(warpRouteId, WarpRouteMonitorHelmManager.helmReleasePrefix)}-0`;

    rootLogger.info(chalk.grey.italic(`Fetching pod status...`));
    const pod = HelmManager.runK8sCommand('get pod', podName, environment);
    rootLogger.info(chalk.green(pod));

    rootLogger.info(chalk.gray.italic(`Fetching latest logs...`));
    const latestLogs = HelmManager.runK8sCommand('logs', podName, environment, [
      `--tail=${LOG_AMOUNT}`,
    ]);
    formatAndPrintLogs(latestLogs);

    rootLogger.info(
      orange.bold(`Grafana Dashboard: ${GRAFANA_LINK}${warpRouteId}\n`),
    );
  } catch (error) {
    rootLogger.error(`Failed to get status for ${warpRouteId}:`, error);
  }
}

function formatAndPrintLogs(rawLogs: string) {
  try {
    const logs = rawLogs
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    logs.forEach((log) => {
      const { time, msg, labels, balance, valueUSD } = log;

      let timestamp: string;
      if (typeof time === 'string') {
        timestamp = new Date(time).toISOString();
      } else if (
        time &&
        typeof time === 'object' &&
        'seconds' in time &&
        'nanos' in time
      ) {
        const seconds = (time as { seconds: number; nanos: number }).seconds;
        const nanos = (time as { seconds: number; nanos: number }).nanos;
        const milliseconds = seconds * 1000 + nanos / 1000000;
        timestamp = new Date(milliseconds).toISOString();
      } else {
        timestamp = new Date().toISOString();
      }

      const module =
        labels?.module ?? log?.serviceContext?.service ?? 'Unknown Module';
      const chain = labels?.chain_name || 'Unknown Chain';
      const token = labels?.token_name || 'Unknown Token';
      const warpRoute = labels?.warp_route_id || 'Unknown Warp Route';
      const tokenStandard =
        labels?.token_standard ??
        labels?.collateral_token_standard ??
        'Unknown Standard';
      const tokenAddress = labels?.token_address || 'Unknown Token Address';
      const walletAddress = labels?.wallet_address || 'Unknown Wallet';

      let logMessage =
        chalk.gray(`[${timestamp}] `) + chalk.white(`[${module}] `);
      logMessage += chalk.blue(`${warpRoute} `);
      logMessage += chalk.green(`${chain} `);
      logMessage += chalk.blue.italic(`Token: ${token} (${tokenAddress}) `);
      logMessage += chalk.green.italic(`${tokenStandard} `);
      logMessage += chalk.blue.italic(`Wallet: ${walletAddress} `);

      if (balance) {
        logMessage += chalk.yellow.italic(`Balance: ${balance} `);
      }
      if (valueUSD) {
        logMessage += chalk.green.italic(`Value (USD): ${valueUSD} `);
      }
      logMessage += chalk.white(`→ ${msg ?? log.message}\n`);

      rootLogger.info(logMessage);
    });
  } catch (err) {
    rootLogger.warn('Could not parse logs as JSON, showing raw logs:');
    rootLogger.info(rawLogs);
  }
}

main().catch((err) => {
  rootLogger.error(err);
  process.exit(1);
});
