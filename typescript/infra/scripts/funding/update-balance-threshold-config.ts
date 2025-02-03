import { checkbox } from '@inquirer/prompts';
import yargs from 'yargs';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import rawDailyBurn from '../../config/environments/mainnet3/balances/dailyRelayerBurn.json';
import {
  BalanceThresholdType,
  RELAYER_BALANCE_TARGET_DAYS,
  THRESHOLD_CONFIG_PATH,
  balanceThresholdConfigMapping,
} from '../../src/config/funding/balances.js';
import {
  formatBalanceThreshold,
  sortThresholds,
} from '../../src/funding/grafana.js';
import { readJSONAtPath, writeJsonAtPath } from '../../src/utils/utils.js';
import {
  withBalanceThresholdConfig,
  withConfirmAllChoices,
} from '../agent-utils.js';

const dailyBurn: ChainMap<number> = rawDailyBurn;

async function main() {
  const { balanceThresholdConfig, all } = await withConfirmAllChoices(
    withBalanceThresholdConfig(yargs(process.argv.slice(2))),
  ).argv;

  const configToUpdate: BalanceThresholdType[] = all
    ? Object.values(BalanceThresholdType)
    : balanceThresholdConfig
    ? [balanceThresholdConfig]
    : await checkbox({
        message: 'Select the balance threshold config to update',
        choices: Object.values(BalanceThresholdType).map((config) => ({
          name: balanceThresholdConfigMapping[config].choiceLabel,
          value: config,
          checked: true, // default to all checked
        })),
      });

  const desiredRelayerBalanceOverrides: ChainMap<string> = readJSONAtPath(
    `${THRESHOLD_CONFIG_PATH}/desiredRelayerBalanceOverrides.json`,
  );

  for (const config of configToUpdate) {
    rootLogger.info(`Updating ${config} config`);

    let currentThresholds: ChainMap<string> = {};
    const newThresholds: ChainMap<string> = {};

    currentThresholds = readJSONAtPath(
      `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[config].configFileName}`,
    );

    const manualReview: Array<{
      chain: string;
      proposedThreshold: number;
      currentThreshold: number;
    }> = [];

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

    if (manualReview.length) {
      rootLogger.info(
        `Table contains ${config} proposed thresholds that are 50% less than the current thresholds, consider manually reviewing and updating the thresholds`,
      );
      console.table(manualReview);
    }

    const sortedThresholds = sortThresholds(newThresholds);

    try {
      rootLogger.info(`Writing ${config} config to file..`);
      writeJsonAtPath(
        `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[config].configFileName}`,
        sortedThresholds,
      );
      rootLogger.info(`Successfully updated ${config} config`);
    } catch (e) {
      rootLogger.error(`Error writing ${config} config: ${e}`);
    }
  }
}

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

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
