import chalk from 'chalk';

import { WarpCoreConfig, parseTokenConnectionId } from '@hyperlane-xyz/sdk';

import { WarpRouteIds } from '../../../config/environments/mainnet3/warp/warpIds.js';
import { getRegistry } from '../../../config/registry.js';

const warpRouteId = WarpRouteIds.oUSDT;
const chainsToPrune = [
  'ink',
  'worldchain',
  'ronin',
  'bitlayer',
  'linea',
  'mantle',
  'sonic',
];

function pruneProdConfig({ tokens, options }: WarpCoreConfig): WarpCoreConfig {
  const prunedTokens = tokens.map((token) => {
    if (chainsToPrune.includes(token.chainName)) {
      return { ...token, connections: undefined };
    }
    if (token.connections) {
      const filteredConnections = token.connections.filter((connection) => {
        const { chainName } = parseTokenConnectionId(connection.token);
        return !chainsToPrune.includes(chainName);
      });
      return { ...token, connections: filteredConnections };
    }
    return token;
  });
  return { tokens: prunedTokens, options };
}

async function main() {
  const registry = getRegistry();

  const warpRoute = registry.getWarpRoute(warpRouteId);
  if (!warpRoute) {
    throw new Error(`Warp route ${warpRouteId} not found`);
  }

  const prunedWarpRoute = pruneProdConfig(warpRoute);

  try {
    registry.addWarpRoute(prunedWarpRoute, {
      warpRouteId,
    });
  } catch (error) {
    console.error(
      chalk.red(`Failed to add warp route for ${warpRouteId}:`, error),
    );
  }

  // TODO: Use registry.getWarpRoutesPath() to dynamically generate path by removing "protected"
  console.log(
    chalk.green(
      `Warp Route successfully updated at ${registry.getUri()}/deployments/warp_routes/${warpRouteId}-config.yaml`,
    ),
  );
}

main().catch((err) => console.error(chalk.bold.red('Error:', err)));
