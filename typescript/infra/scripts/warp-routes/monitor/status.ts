import chalk from 'chalk';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HelmManager } from '../../../src/utils/helm.js';
import { WarpRouteMonitorHelmManager } from '../../../src/warp/helm.js';
import {
  assertCorrectKubeContext,
  getArgs,
  withWarpRouteIdRequired,
} from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

const orange = chalk.hex('#FFA500');
const GRAFANA_LINK =
  'https://abacusworks.grafana.net/d/ddz6ma94rnzswc/warp-routes?orgId=1&var-warp_route_id=';
const LOG_AMOUNT = 5;

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId } =
    await withWarpRouteIdRequired(getArgs()).parse();

  const config = getEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);

  try {
    const podWarpRouteId = `${WarpRouteMonitorHelmManager.getHelmReleaseName(
      warpRouteId,
    )}-0`;

    rootLogger.info(chalk.grey.italic(`Fetching pod status...`));
    const pod = HelmManager.runK8sCommand(
      'get pod',
      podWarpRouteId,
      environment,
    );
    rootLogger.info(chalk.green(pod));

    rootLogger.info(chalk.gray.italic(`Fetching latest logs...`));
    const latestLogs = HelmManager.runK8sCommand(
      'logs',
      podWarpRouteId,
      environment,
      [`--tail=${LOG_AMOUNT}`],
    );
    formatAndPrintLogs(latestLogs);

    rootLogger.info(
      orange.bold(`Grafana Dashboard Link: ${GRAFANA_LINK}${warpRouteId}`),
    );
  } catch (error) {
    rootLogger.error(error);
    process.exit(1);
  }
}

/**
 * Parses and formats raw log output as JSON lines, then prints each entry with colorized and structured details.
 *
 * @param rawLogs - The raw log string, where each line is a JSON-formatted log entry.
 *
 * @remark
 * If a log line cannot be parsed as JSON, an error is logged and processing continues for other lines.
 */
function formatAndPrintLogs(rawLogs: string) {
  try {
    const logs = rawLogs
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    logs.forEach((log) => {
      const { time, module, msg, labels, balance, valueUSD } = log;
      const timestamp = new Date(time).toISOString();
      const chain = labels?.chain_name || 'Unknown Chain';
      const token = labels?.token_name || 'Unknown Token';
      const warpRoute = labels?.warp_route_id || 'Unknown Warp Route';
      const tokenStandard = labels?.token_standard || 'Unknown Standard';
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
      logMessage += chalk.white(`→ ${msg}\n`);

      rootLogger.info(logMessage);
    });
  } catch (err) {
    rootLogger.error(err, 'Failed to parse logs');
  }
}

main().catch((err) => {
  rootLogger.error(err);
  process.exit(1);
});
