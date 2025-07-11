import {
  ChainMap,
  ChainName,
  ProtocolAgnositicGasOracleConfig,
} from '@hyperlane-xyz/sdk';
import { objFilter, objMap, stringifyObject } from '@hyperlane-xyz/utils';

import { getChains, getWarpAddresses } from '../../config/registry.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';
import { getArgs, withOutputFile } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

interface GasOracleConfigWithOverhead {
  oracleConfig: ProtocolAgnositicGasOracleConfig;
  overhead?: number;
}

async function main() {
  const allChainChoices = getChains();

  const {
    environment,
    outFile,
    origin: originFilter,
    destination: destinationFilter,
  } = await withOutputFile(getArgs())
    .describe('origin', 'Origin chain')
    .string('origin')
    .choices('origin', allChainChoices)
    .describe('destination', 'Destination chain')
    .string('destination')
    .choices('destination', allChainChoices).argv;

  const environmentConfig = getEnvironmentConfig(environment);

  // Construct a nested map of origin -> destination -> { oracleConfig, overhead }
  const gasOracles = Object.entries(environmentConfig.igp).reduce(
    (acc, [origin, igpConfig]) => {
      // Skip if origin filter is set and doesn't match
      if (originFilter && originFilter !== origin) {
        return acc;
      }

      // Skip if there's no oracle config for this origin
      if (!igpConfig.oracleConfig) {
        return acc;
      }

      // Process destinations for this origin
      const destinationConfigs = environmentConfig.supportedChainNames.reduce(
        (destAcc, destination) => {
          // Skip if destination filter is set and doesn't match
          if (destinationFilter && destinationFilter !== destination) {
            return destAcc;
          }

          // Skip self-referential routes
          if (destination === origin) {
            return destAcc;
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

          destAcc[destination] = {
            oracleConfig,
            overhead: igpConfig?.overhead?.[destination],
          };
          return destAcc;
        },
        {} as ChainMap<GasOracleConfigWithOverhead>,
      );

      // Only add to accumulator if we have valid destination configs
      if (Object.keys(destinationConfigs).length > 0) {
        acc[origin] = destinationConfigs;
      }

      return acc;
    },
    {} as Record<string, ChainMap<GasOracleConfigWithOverhead>>,
  );

  console.log(stringifyObject(gasOracles, 'json', 2));

  if (outFile) {
    console.log(`Writing config to ${outFile}`);
    writeJsonAtPath(outFile, gasOracles);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
