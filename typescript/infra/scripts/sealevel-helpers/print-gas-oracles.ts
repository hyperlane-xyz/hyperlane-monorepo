import {
  ChainMap,
  ChainName,
  ProtocolAgnositicGasOracleConfig,
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
import { writeJsonAtPath } from '../../src/utils/utils.js';
import { getArgs, withOutputFile } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// This script exists to print the gas oracle configs for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

interface GasOracleConfigWithOverhead {
  oracleConfig: ProtocolAgnositicGasOracleConfig;
  overhead?: number;
}

async function main() {
  const { environment, outFile } = await withOutputFile(getArgs()).argv;

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
    const connectedChains = [...connectedChainsSet];

    return connectedChains.reduce((agg, destination) => {
      const oracleConfig = igpConfig.oracleConfig[destination];
      if (oracleConfig.tokenDecimals === undefined) {
        throw new Error(
          `Token decimals not defined for ${origin} -> ${destination}`,
        );
      }
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

  console.log(stringifyObject(gasOracles, 'json', 2));

  if (outFile) {
    console.log(`Writing config to ${outFile}`);
    writeJsonAtPath(outFile, gasOracles);
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
      // For the Rivalz team building out their own warp route
      ['solanamainnet', 'rivalz'],
      ['solanamainnet', 'everclear'],
      ['solanamainnet', 'infinityvmmainnet'],
      ['solanamainnet', 'sophon'],
      ['solanamainnet', 'abstract'],
      ['solanamainnet', 'apechain'],
      ['solanamainnet', 'subtensor'],
      // For Starknet
      ['solanamainnet', 'starknet'],
      // for svmBNB routes solana<>bsc<>svmbnb<>soon
      ['solanamainnet', 'bsc'],
      ['svmbnb', 'solanamainnet'],
      ['svmbnb', 'bsc'],
      ['svmbnb', 'soon'],
      ['soon', 'solanamainnet'],
      ['soon', 'bsc'],
      // for eclipse routes
      ['eclipsemainnet', 'sonicsvm'],
      ['eclipsemainnet', 'soon'],
      // All warp routes
      ...Object.values(WarpRouteIds).map(getWarpChains),
    ];
  } else if (environment === 'testnet4') {
    connectedChains = [
      // As testnet warp routes are not tracked well, hardcode the connected chains.
      // For SOL/solanatestnet-sonicsvmtestnet
      ['solanatestnet', 'sonicsvmtestnet'],
      ['solanatestnet', 'connextsepolia'],
      ['solanatestnet', 'infinityvmmonza'],
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
