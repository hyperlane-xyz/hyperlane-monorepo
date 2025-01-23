import { checkbox } from '@inquirer/prompts';
import yargs from 'yargs';

import { ChainMap } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import rawDailyBurn from '../../config/environments/mainnet3/balances/dailyBurn.json';
import { readJSONAtPath, writeJsonAtPath } from '../../src/utils/utils.js';
import { withBalanceThresholdConfig } from '../agent-utils.js';

import {
  BalanceThresholdConfig,
  configFileNameMapping,
  dailyBurnMultiplier,
} from './utils/constants.js';
import { THRESHOLD_CONFIG_PATH } from './utils/grafana.js';
import { formatDailyBurn } from './utils/utils.js';

const dailyBurn: ChainMap<number> = rawDailyBurn;

export const configChoiceLabelMapping: Record<BalanceThresholdConfig, string> =
  {
    [BalanceThresholdConfig.RelayerBalance]: 'Desired Relayer Balance',
    [BalanceThresholdConfig.LowUrgencyKeyFunderBalance]:
      'Low Urgency Key Funder Balance Alert Threshold',
    [BalanceThresholdConfig.LowUrgencyEngKeyFunderBalance]:
      'Low Urgency Eng Key Funder Balance Alert Threshold',
    [BalanceThresholdConfig.HighUrgencyRelayerBalance]:
      'High Urgency Relayer Balance',
  };

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { balanceThresholdConfig } = await withBalanceThresholdConfig(
    yargs(process.argv.slice(2)),
  ).argv;

  const configToUpdate: BalanceThresholdConfig[] = balanceThresholdConfig
    ? [balanceThresholdConfig]
    : [];

  if (configToUpdate.length === 0) {
    const selectedConfig = await checkbox({
      message: 'Select the balance threshold config to update',
      choices: Object.values(BalanceThresholdConfig).map((config) => ({
        name: configChoiceLabelMapping[config],
        value: config,
        checked: true, // default to all checked
      })),
    });

    configToUpdate.push(...selectedConfig);
  }

  for (const config of configToUpdate) {
    rootLogger.info(`Updating ${config} config`);

    let currentThresholds: ChainMap<number> = {};
    const newThresholds: ChainMap<number> = {};
    try {
      currentThresholds = readJSONAtPath(
        `${THRESHOLD_CONFIG_PATH}/${configFileNameMapping[config]}`,
      );
    } catch (e) {
      rootLogger.error(`Error reading ${config} config: ${e}`);
    }

    // Update the threshold for each chain, if it doesn't exist, create a new one
    for (const chain in dailyBurn) {
      if (!(chain in currentThresholds)) {
        newThresholds[chain] = formatDailyBurn(
          dailyBurn[chain] * dailyBurnMultiplier[config],
        );
      } else {
        newThresholds[chain] = Math.max(
          formatDailyBurn(dailyBurn[chain] * dailyBurnMultiplier[config]),
          currentThresholds[chain],
        );
      }
    }

    try {
      rootLogger.info(`Writing ${config} config to file..`);
      writeJsonAtPath(
        `${THRESHOLD_CONFIG_PATH}/${configFileNameMapping[config]}`,
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
