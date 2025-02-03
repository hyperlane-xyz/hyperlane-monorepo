import { checkbox } from '@inquirer/prompts';
import yargs from 'yargs';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import rawDailyBurn from '../../config/environments/mainnet3/balances/dailyRelayerBurn.json';
import {
  BalanceThresholdType,
  THRESHOLD_CONFIG_PATH,
  balanceThresholdConfigMapping,
} from '../../src/config/funding/balances.js';
import {
  formatDailyRelayerBurn,
  sortThresholds,
} from '../../src/funding/grafana.js';
import { readJSONAtPath, writeJsonAtPath } from '../../src/utils/utils.js';
import {
  withBalanceThresholdConfig,
  withConfirmAllChoices,
} from '../agent-utils.js';

const dailyBurn: ChainMap<number> = rawDailyBurn;

const exclusionList = ['osmosis'];

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

  for (const config of configToUpdate) {
    rootLogger.info(`Updating ${config} config`);

    let currentThresholds: ChainMap<string> = {};
    const newThresholds: ChainMap<string> = {};
    try {
      currentThresholds = readJSONAtPath(
        `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[config].configFileName}`,
      );
    } catch (e) {
      rootLogger.error(`Error reading ${config} config: ${e}`);
    }

    // Update the threshold for each chain, if it doesn't exist, create a new one
    for (const chain in dailyBurn) {
      if (!currentThresholds[chain]) {
        // Skip chains in the exclusion list
        if (exclusionList.includes(chain)) {
          rootLogger.info(`Skipping ${chain} as it is in the exclusion list`);
          continue;
        }

        newThresholds[chain] = formatDailyRelayerBurn(
          dailyBurn[chain] *
            balanceThresholdConfigMapping[config].dailyRelayerBurnMultiplier,
        ).toString();
      } else {
        // This will ensure that chains where the desired threshold is 0 will be unchanged
        if (
          config === BalanceThresholdType.RelayerBalance &&
          parseFloat(currentThresholds[chain]) === 0
        ) {
          newThresholds[chain] = currentThresholds[chain];
          continue;
        }

        newThresholds[chain] = Math.max(
          formatDailyRelayerBurn(
            dailyBurn[chain] *
              balanceThresholdConfigMapping[config].dailyRelayerBurnMultiplier,
          ),
          parseFloat(currentThresholds[chain]),
        ).toString();
      }
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

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
