import chalk from 'chalk';
import { execSync } from 'child_process';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../../../config/environments/mainnet3/warp/warpIds.js';
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
const POD_PREFIX = 'hyperlane-warp-route';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId } = await withWarpRouteIdRequired(
    getArgs(),
  ).parse();

  const config = getEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);

  try {
    if (!Object.values(WarpRouteIds).includes(warpRouteId as WarpRouteIds)) {
      throw new Error(
        `Invalid warpRouteId: ${warpRouteId}. Must be one of the defined WarpRouteIds.`,
      );
    }

    const podWarpRouteId = getPodWarpRouteId(warpRouteId);

    rootLogger.info(chalk.grey.italic(`Fetching pod status...`));
    const pod = runKubernetesWarpRouteCommand(
      'get pod',
      podWarpRouteId,
      environment,
    );
    rootLogger.info(chalk.green(pod));

    rootLogger.info(chalk.gray.italic(`Fetching latest logs...`));
    const latestLogs = runKubernetesWarpRouteCommand(
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

function getPodWarpRouteId(warpRouteId: string) {
  return `${POD_PREFIX}-${warpRouteId.replace('/', '-').toLowerCase()}-0`;
}

function runKubernetesWarpRouteCommand(
  command: string,
  warpRouteId: string,
  namespace: string,
  args: string[] = [],
) {
  const argsString = args.join(' ');
  return execSync(
    `kubectl ${command} ${warpRouteId} -n ${namespace} ${argsString}`,
    {
      encoding: 'utf-8',
    },
  );
}

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
  } catch (error) {
    rootLogger.error(`Failed to parse logs: ${error}`);
  }
}

main().catch((err) => {
  rootLogger.error('Error in main:', err);
  process.exit(1);
});
