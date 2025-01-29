import chalk from 'chalk';
import { execSync } from 'child_process';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../../../config/environments/mainnet3/warp/warpIds.js';
import { getArgs, withWarpRouteIdRequired } from '../../agent-utils.js';

const orange = chalk.hex('#FFA500');

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId } = await withWarpRouteIdRequired(
    getArgs(),
  ).parse();

  try {
    if (!Object.values(WarpRouteIds).includes(warpRouteId as WarpRouteIds)) {
      throw new Error(
        `Invalid warpRouteId: ${warpRouteId}. Must be one of the defined WarpRouteIds.`,
      );
    }

    const monitorWarpRouteId = getMonitorWarpRouteId(warpRouteId);

    rootLogger.info(chalk.grey.italic(`Fetching pod status...`));
    const pod = runKubernetesWarpRouteCommand(
      'get pod',
      monitorWarpRouteId,
      environment,
    );
    rootLogger.info(chalk.green(pod));

    rootLogger.info(chalk.gray.italic(`Fetching latest logs...`));
    const latestLogs = runKubernetesWarpRouteCommand(
      'logs',
      monitorWarpRouteId,
      environment,
      ['--tail=5'],
    );
    rootLogger.info(latestLogs);

    rootLogger.info(
      orange.bold(
        `Grafana Dashboard Link: https://abacusworks.grafana.net/d/ddz6ma94rnzswc/warp-routes?orgId=1&var-warp_route_id=${warpRouteId}`,
      ),
    );
  } catch (error) {
    rootLogger.error(error);
    process.exit(1);
  }
}

function getMonitorWarpRouteId(warpRouteId: string) {
  return `hyperlane-warp-route-${warpRouteId
    .replace('/', '-')
    .toLowerCase()}-0`;
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

main().catch((err) => {
  rootLogger.error('Error in main:', err);
  process.exit(1);
});
