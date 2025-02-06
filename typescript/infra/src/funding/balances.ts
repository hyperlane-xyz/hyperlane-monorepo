import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  BalanceThresholdType,
  ThresholdConfigs,
  balanceThresholdConfigMapping,
} from '../config/funding/balances.js';

/**
 * Validates that the thresholds are sized correctly across configs.
 * This function logs warnings for chains present in lower-priority configs but missing in higher-priority configs.
 * It also logs errors if the thresholds are not sized correctly.
 */
export function validateThresholds(newConfigs: ThresholdConfigs): void {
  // Accumulate error and warning messages.
  const errorMessages: string[] = [];
  const warningMessages: string[] = [];

  // Sort the config types by their weight (ascending order).
  // Lower weight means a higher-priority threshold.
  const configTypesSorted = Object.keys(newConfigs)
    .map((key) => key as BalanceThresholdType)
    .sort(
      (a, b) =>
        balanceThresholdConfigMapping[a].weight -
        balanceThresholdConfigMapping[b].weight,
    );

  for (let i = 0; i < configTypesSorted.length - 1; i++) {
    const higherPriorityConfig = configTypesSorted[i]; // e.g. weight 1 (highest threshold)
    const lowerPriorityConfig = configTypesSorted[i + 1]; // e.g. weight 2 (next highest)

    const thresholdsHigh = newConfigs[higherPriorityConfig].thresholds;
    const thresholdsLow = newConfigs[lowerPriorityConfig].thresholds;

    // Check chains present in the higher-priority config.
    for (const chain in thresholdsHigh) {
      if (chain in thresholdsLow) {
        const valueHigh = parseFloat(thresholdsHigh[chain]);
        const valueLow = parseFloat(thresholdsLow[chain]);

        if (valueHigh <= valueLow) {
          errorMessages.push(
            `Chain "${chain}": ${higherPriorityConfig} threshold (${valueHigh}) is not greater than ${lowerPriorityConfig} threshold (${valueLow}).`,
          );
        }
      } else {
        warningMessages.push(
          `Chain "${chain}" is present in ${higherPriorityConfig} but missing in ${lowerPriorityConfig}.`,
        );
      }
    }

    // Also log warnings for chains present in the lower-priority config but missing from the higher-priority config.
    for (const chain in thresholdsLow) {
      if (!(chain in thresholdsHigh)) {
        warningMessages.push(
          `Chain "${chain}" is present in ${lowerPriorityConfig} but missing in ${higherPriorityConfig}.`,
        );
      }
    }
  }

  if (warningMessages.length > 0) {
    rootLogger.warn('Threshold validation warnings:');
    warningMessages.forEach((msg) => rootLogger.warn(msg));
  }

  if (errorMessages.length > 0) {
    rootLogger.error('Threshold validation completed with errors:');
    errorMessages.forEach((msg) => rootLogger.error(msg));
    process.exit(1);
  } else {
    rootLogger.info('All thresholds validated successfully across configs.');
  }
}

export function formatBalanceThreshold(dailyRelayerBurn: number): number {
  return Number(dailyRelayerBurn.toPrecision(3));
}

export function sortThresholds(
  newThresholds: ChainMap<string>,
): ChainMap<string> {
  return Object.fromEntries(
    Object.entries(newThresholds).sort(([keyA], [keyB]) =>
      keyA.localeCompare(keyB),
    ),
  );
}
