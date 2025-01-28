import { checkbox } from '@inquirer/prompts';
import yargs from 'yargs';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import rawDailyBurn from '../../config/environments/mainnet3/balances/dailyRelayerBurn.json';
import { readJSONAtPath, writeJsonAtPath } from '../../src/utils/utils.js';
import { withBalanceThresholdConfig } from '../agent-utils.js';

import {
  BalanceThresholdType,
  balanceThresholdConfigMapping,
} from './utils/constants.js';
import {
  THRESHOLD_CONFIG_PATH,
  formatDailyRelayerBurn,
} from './utils/grafana.js';

const dailyBurn: ChainMap<number> = rawDailyBurn;

async function main() {
  const { balanceThresholdConfig } = await withBalanceThresholdConfig(
    yargs(process.argv.slice(2)),
  ).argv;

  const configToUpdate: BalanceThresholdType[] = balanceThresholdConfig
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
        newThresholds[chain] = formatDailyRelayerBurn(
          dailyBurn[chain] *
            balanceThresholdConfigMapping[config].dailyRelayerBurnMultiplier,
        ).toString();
      } else {
        newThresholds[chain] = Math.max(
          formatDailyRelayerBurn(
            dailyBurn[chain] *
              balanceThresholdConfigMapping[config].dailyRelayerBurnMultiplier,
          ),
          parseFloat(currentThresholds[chain]),
        ).toString();
      }
    }

    try {
      rootLogger.info(`Writing ${config} config to file..`);
      writeJsonAtPath(
        `${THRESHOLD_CONFIG_PATH}/${balanceThresholdConfigMapping[config].configFileName}`,
        newThresholds,
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
