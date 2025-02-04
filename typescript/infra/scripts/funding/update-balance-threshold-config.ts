import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import rawDailyBurn from '../../config/environments/mainnet3/balances/dailyRelayerBurn.json';
import {
  BalanceThresholdType,
  ManualReview,
  RELAYER_BALANCE_TARGET_DAYS,
  THRESHOLD_CONFIG_PATH,
  ThresholdConfigs,
  balanceThresholdConfigMapping,
} from '../../src/config/funding/balances.js';
import { validateThresholds } from '../../src/funding/balances.js';
import {
  formatBalanceThreshold,
  sortThresholds,
} from '../../src/funding/grafana.js';
import { readJSONAtPath, writeJsonAtPath } from '../../src/utils/utils.js';

const dailyBurn: ChainMap<number> = rawDailyBurn;

async function main() {
  const configsToUpdate = Object.values(BalanceThresholdType);
  const newConfigs: ThresholdConfigs = configsToUpdate.reduce<ThresholdConfigs>(
    (acc, config) => {
      return {
        ...acc,
        [config]: { thresholds: {} },
      };
    },
    {} as ThresholdConfigs,
  );

  const desiredRelayerBalanceOverrides: ChainMap<string> = readJSONAtPath(
    `${THRESHOLD_CONFIG_PATH}/desiredRelayerBalanceOverrides.json`,
  );

  for (const config of configsToUpdate) {
    let currentThresholds: ChainMap<string> = {};
    const newThresholds: ChainMap<string> = {};

    currentThresholds = readJSONAtPath(
      `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[config].configFileName}`,
    );

    const manualReview: Array<ManualReview> = [];

    for (const chain in dailyBurn) {
      // check if there is an override for the desired relayer balance, if so, use that to calculate the threshold
      if (desiredRelayerBalanceOverrides[chain]) {
        const override = handleDesiredRelayerBalanceOverride(
          chain,
          desiredRelayerBalanceOverrides[chain],
          config,
        );
        if (override) {
          newThresholds[chain] = override;
        }
      } else {
        // no overrides, update the threshold for each chain, if it doesn't exist, create a new one
        if (!currentThresholds[chain]) {
          newThresholds[chain] = formatBalanceThreshold(
            dailyBurn[chain] *
              balanceThresholdConfigMapping[config].dailyRelayerBurnMultiplier,
          ).toString();
        } else {
          const proposedThreshold = formatBalanceThreshold(
            dailyBurn[chain] *
              balanceThresholdConfigMapping[config].dailyRelayerBurnMultiplier,
          );

          // check if proposedThreshold is 50% less than currentThreshold, if so suggest manual review
          if (proposedThreshold < parseFloat(currentThresholds[chain]) * 0.5) {
            manualReview.push({
              chain,
              proposedThreshold: formatBalanceThreshold(proposedThreshold),
              currentThreshold: formatBalanceThreshold(
                parseFloat(currentThresholds[chain]),
              ),
            });
          }

          newThresholds[chain] = Math.max(
            proposedThreshold,
            parseFloat(currentThresholds[chain]),
          ).toString();
        }
      }
    }

    const sortedThresholds = sortThresholds(newThresholds);

    newConfigs[config] = {
      thresholds: sortedThresholds,
      manualReview,
    };
  }

  validateThresholds(newConfigs);
  handleManualReviews(newConfigs);
  writeConfigsToFile(newConfigs);
}

/**
 * Handles the desired relayer balance override for a given chain.
 */
function handleDesiredRelayerBalanceOverride(
  chain: string,
  override: string,
  configType: BalanceThresholdType,
): string | undefined {
  if (override === '0') {
    // zero balance covers two cases:
    // 1. new chain: we don't want key funder to attempt fund the chain and we don't want alerting for now
    // 2. special cases where the relayer is not in use and balance should be 0, covers the osmosis case
    if (configType === BalanceThresholdType.DesiredRelayerBalance) {
      return override;
    } else {
      return undefined;
    }
  }

  // derive a new daily burn threshold based on the override
  const dailyRelayerBurnOverride =
    parseFloat(override) / RELAYER_BALANCE_TARGET_DAYS;

  // calculate the new threshold based on the override using config multiplier
  return formatBalanceThreshold(
    dailyRelayerBurnOverride *
      balanceThresholdConfigMapping[configType].dailyRelayerBurnMultiplier,
  ).toString();
}

/**
 * Writes each config’s thresholds object to its designated JSON file.
 */
function writeConfigsToFile(newConfigs: ThresholdConfigs) {
  for (const configKey of Object.keys(newConfigs) as BalanceThresholdType[]) {
    const { thresholds } = newConfigs[configKey];

    try {
      rootLogger.info(`Writing ${configKey} config to file`);
      writeJsonAtPath(
        `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[configKey].configFileName}`,
        thresholds,
      );
      rootLogger.info(`Successfully updated ${configKey} config`);
    } catch (e) {
      rootLogger.error(`Error writing ${configKey} config to file: ${e}`);
    }
  }
}

/**
 * If any manual review items exist for a config, prints an informational message
 * and displays a table of the chain thresholds that require review.
 */
function handleManualReviews(newConfigs: ThresholdConfigs) {
  for (const configKey of Object.keys(newConfigs) as BalanceThresholdType[]) {
    const { manualReview } = newConfigs[configKey];
    if (manualReview && manualReview.length > 0) {
      rootLogger.info(
        `The ${configKey} config contains ${manualReview.length} chain(s) where the proposed threshold is less than 50% of the current threshold. Please review the following items:`,
      );
      console.table(manualReview);
    }
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
