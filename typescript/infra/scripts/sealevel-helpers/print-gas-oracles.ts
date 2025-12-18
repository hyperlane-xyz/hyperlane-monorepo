import {
  ChainMap,
  ChainName,
  ProtocolAgnositicGasOracleConfigWithTypicalCost,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  objFilter,
  objMap,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { getChain, getWarpAddresses } from '../../config/registry.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { svmGasOracleConfigPath } from '../../src/utils/sealevel.js';
import { writeAndFormatJsonAtPath } from '../../src/utils/utils.js';
import { getArgs, withWrite } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// This script exists to print the gas oracle configs for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

interface GasOracleConfigWithOverhead {
  oracleConfig: ProtocolAgnositicGasOracleConfigWithTypicalCost;
  overhead?: number;
}

async function main() {
  const { environment, write } = await withWrite(getArgs()).argv;

  const environmentConfig = getEnvironmentConfig(environment);

  const allConnectedChains = getChainConnections(environment);

  // Construct a nested map of origin -> destination -> { oracleConfig, overhead }
  let gasOracles = objMap(environmentConfig.igp, (origin, igpConfig) => {
    // Only SVM origins for now
    if (getChain(origin).protocol !== ProtocolType.Sealevel) {
      return undefined;
    }

    // If there's no oracle config, don't do anything for this origin
    if (!igpConfig.oracleConfig) {
      return undefined;
    }
    // Get the set of chains that are connected to this origin via warp routes
    const connectedChainsSet = allConnectedChains[origin];
    if (!connectedChainsSet) {
      return undefined;
    }
    const connectedChains = [...connectedChainsSet].sort();

    return connectedChains.reduce((agg, destination) => {
      const oracleConfig = igpConfig.oracleConfig[destination];
      if (oracleConfig.tokenDecimals === undefined) {
        throw new Error(
          `Token decimals not defined for ${origin} -> ${destination}`,
        );
      }
      // Strip out the typical cost that may or may not be defined
      delete oracleConfig.typicalCost;

      agg[destination] = {
        oracleConfig,
        overhead: igpConfig?.overhead?.[destination],
      };
      return agg;
    }, {} as ChainMap<GasOracleConfigWithOverhead>);
  });

  // Filter out undefined values
  gasOracles = objFilter(
    gasOracles,
    (_, value): value is ChainMap<GasOracleConfigWithOverhead> | undefined =>
      value !== undefined,
  );

  if (write) {
    const filepath = svmGasOracleConfigPath(environment);
    console.log(`Writing config to ${filepath}`);
    await writeAndFormatJsonAtPath(filepath, gasOracles);
  } else {
    console.log(stringifyObject(gasOracles, 'json', 2));
  }
}

// Gets the chains in the provided warp route
function getWarpChains(warpRouteId: string): ChainName[] {
  const warpRouteAddresses = getWarpAddresses(warpRouteId);
  return Object.keys(warpRouteAddresses);
}

// Because there is a limit to how many chains we want to figure in an SVM IGP,
// we limit the chains to only those that are connected via warp routes.
// Returns a record of origin chain -> set of chains that are connected via warp routes.
function getChainConnections(
  environment: DeployEnvironment,
): ChainMap<Set<ChainName>> {
  // A list of connected chains
  let connectedChains = [];

  if (environment === 'mainnet3') {
    // All the mainnet3 warp route chains
    connectedChains = [
      ['solanamainnet', 'everclear'],
      ['solanamainnet', 'sophon'],
      ['solanamainnet', 'abstract'],
      ['solanamainnet', 'apechain'],
      ['solanamainnet', 'subtensor'],
      ['solanamainnet', 'pulsechain'],
      ['solanamainnet', 'electroneum'],
      ['solanamainnet', 'galactica'],
      ['solanamainnet', 'radix'],
      ['solanamainnet', 'carrchain'],
      ['solanamainnet', 'incentiv'],
      ['solanamainnet', 'litchain'],
      // For Starknet / Paradex
      ['solanamainnet', 'starknet'],
      ['solanamainnet', 'paradex'],
      ['solanamainnet', 'bsc'],
      ['soon', 'solanamainnet'],
      ['soon', 'bsc'],
      // for eclipse routes
      ['eclipsemainnet', 'sonicsvm'],
      ['eclipsemainnet', 'soon'],
      ['eclipsemainnet', 'katana'],
      // for solaxy routes
      ['solaxy', 'solanamainnet'],
      ['solaxy', 'ethereum'],
      // for celestia svm routes
      ['celestia', 'solanamainnet'],
      ['celestia', 'eclipsemainnet'],
      // All warp routes
      ...Object.values(WarpRouteIds).map(getWarpChains),
    ];
  } else if (environment === 'testnet4') {
    connectedChains = [
      // As testnet warp routes are not tracked well, hardcode the connected chains.
      // For SOL/solanatestnet-sonicsvmtestnet
      ['solanatestnet', 'sonicsvmtestnet'],
      ['solanatestnet', 'connextsepolia'],
      ['solanatestnet', 'basesepolia'],
    ];
  } else {
    throw new Error(`Unknown environment: ${environment}`);
  }

  return connectedChains.reduce(
    (agg, chains) => {
      // Make sure each chain is connected to every other chain
      chains.forEach((chainA) => {
        chains.forEach((chainB) => {
          if (chainA === chainB) {
            return;
          }
          if (agg[chainA] === undefined) {
            agg[chainA] = new Set();
          }
          agg[chainA].add(chainB as ChainName);
        });
      });
      return agg;
    },
    {} as ChainMap<Set<ChainName>>,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
