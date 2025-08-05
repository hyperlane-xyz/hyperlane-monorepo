import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  BalanceThresholdType,
  THRESHOLD_CONFIG_PATH,
  ThresholdsData,
  balanceThresholdConfigMapping,
} from '../config/funding/balances.js';
import { readJSONAtPath } from '../utils/utils.js';

export function validateThresholds(thresholdsData: ThresholdsData): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  const chains = Object.keys(
    thresholdsData[BalanceThresholdType.DesiredRelayerBalance],
  );

  for (const chain of chains) {
    const chainThresholds = getCurrentChainThresholds(chain, thresholdsData);
    const chainErrors = checkForThresholdErrors(chainThresholds);
    errors.push(...chainErrors);

    // add warnings for any missing thresholds for this chain
    for (const thresholdType of Object.values(BalanceThresholdType)) {
      if (!chainThresholds[thresholdType]) {
        warnings.push(
          `Threshold for [${thresholdType}] on chain [${chain}] is not defined, this may be expected for new chains where we do not want to set alerts`,
        );
      }
    }
  }

  if (warnings.length > 0) {
    rootLogger.warn(`Found ${warnings.length} threshold validation warnings:`);
    warnings.forEach((msg) => rootLogger.warn(msg));
  }

  if (errors.length > 0) {
    rootLogger.error(`Found ${errors.length} threshold validation errors:`);
    errors.forEach((msg) => rootLogger.error(msg));
    process.exit(1);
  } else {
    rootLogger.info('All thresholds validated successfully.');
  }
}

export function formatBalanceThreshold(dailyRelayerBurn: number): number {
  return Number(dailyRelayerBurn.toPrecision(3));
}

export function sortThresholds(
  newThresholds: ChainMap<number>,
): ChainMap<number> {
  return Object.fromEntries(
    Object.entries(newThresholds).sort(([keyA], [keyB]) =>
      keyA.localeCompare(keyB),
    ),
  );
}

export function checkForThresholdErrors(
  chainThresholds: Record<BalanceThresholdType, number>,
): string[] {
  const errors: string[] = [];

  const sortedTypes = sortThresholdTypes(
    Object.keys(chainThresholds) as BalanceThresholdType[],
  );

  // Compare each adjacent pair
  for (let i = 0; i < sortedTypes.length - 1; i++) {
    const lowerType = sortedTypes[i];
    const higherType = sortedTypes[i + 1];

    const lowerThreshold = chainThresholds[lowerType];
    const higherThreshold = chainThresholds[higherType];

    if (lowerThreshold >= higherThreshold) {
      errors.push(
        `Threshold for [${higherType}] (${higherThreshold}) must be greater than threshold for [${lowerType}] (${lowerThreshold}).`,
      );
    }
  }

  return errors;
}

export function getCurrentChainThresholds(
  chain: string,
  currentThresholds: ThresholdsData,
): Record<BalanceThresholdType, number> {
  const result = {} as Record<BalanceThresholdType, number>;
  for (const thresholdType of Object.values(BalanceThresholdType)) {
    if (currentThresholds[thresholdType][chain]) {
      result[thresholdType] = currentThresholds[thresholdType][chain];
    }
  }
  return result;
}

export function readAllThresholds(): ThresholdsData {
  const result: ThresholdsData = {} as ThresholdsData;

  for (const thresholdType of Object.values(BalanceThresholdType)) {
    const thresholdsFile = `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[thresholdType].configFileName}`;

    const chainMap = readJSONAtPath(thresholdsFile) as ChainMap<number>;

    result[thresholdType] = chainMap;
  }

  return result;
}

export function sortThresholdTypes(
  thresholdTypes: BalanceThresholdType[],
): BalanceThresholdType[] {
  return thresholdTypes.sort((a, b) => {
    return (
      balanceThresholdConfigMapping[a].dailyRelayerBurnMultiplier -
      balanceThresholdConfigMapping[b].dailyRelayerBurnMultiplier
    );
  });
}
