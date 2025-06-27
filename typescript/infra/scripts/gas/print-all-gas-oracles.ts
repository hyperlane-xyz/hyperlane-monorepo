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

import {
  getChain,
  getChains,
  getWarpAddresses,
} from '../../config/registry.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';
import { getArgs, withOutputFile } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// This script exists to print the gas oracle configs for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

interface CostData {
  typicalHandleGasAmount: number;
  typicalTotalGasAmount: number;
  typicalTotalUsdCost: number;
}

interface GasOracleConfigWithOverhead {
  oracleConfig: ProtocolAgnositicGasOracleConfig;
  overhead?: number;
  typicalCost?: CostData;
}

async function main() {
  const allChainChoices = getChains();
  const args = await withOutputFile(getArgs())
    .describe('origin', 'Origin chain')
    .string('origin')
    .choices('origin', allChainChoices)
    .describe('destination', 'Destination chain')
    .string('destination')
    .choices('destination', allChainChoices).argv;

  const {
    environment,
    outFile,
    origin: originFilter,
    destination: destinationFilter,
  } = args;

  const environmentConfig = getEnvironmentConfig(environment);

  // Construct a nested map of origin -> destination -> { oracleConfig, overhead }
  let gasOracles = objMap(environmentConfig.igp, (origin, igpConfig) => {
    if (!!originFilter && originFilter !== origin) {
      return undefined;
    }

    // If there's no oracle config, don't do anything for this origin
    if (!igpConfig.oracleConfig) {
      return undefined;
    }

    return environmentConfig.supportedChainNames.reduce((agg, destination) => {
      if (!!destinationFilter && destinationFilter !== destination) {
        return agg;
      }

      if (destination === origin) {
        return agg;
      }

      const oracleConfig = igpConfig.oracleConfig[destination];
      if (!oracleConfig) {
        throw new Error(
          `No oracle config found for ${origin} -> ${destination}`,
        );
      }

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
