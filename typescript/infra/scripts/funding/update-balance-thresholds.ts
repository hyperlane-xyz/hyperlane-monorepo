import { input, select } from '@inquirer/prompts';
import yargs from 'yargs';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import rawDailyBurn from '../../config/environments/mainnet3/balances/dailyRelayerBurn.json';
import rawDesiredRelayerBalanceOverrides from '../../config/environments/mainnet3/balances/desiredRelayerBalanceOverrides.json';
import {
  BalanceThresholdType,
  RELAYER_BALANCE_TARGET_DAYS,
  THRESHOLD_CONFIG_PATH,
  ThresholdsData,
  balanceThresholdConfigMapping,
} from '../../src/config/funding/balances.js';
import {
  checkForThresholdErrors,
  formatBalanceThreshold,
  getCurrentChainThresholds,
  readAllThresholds,
  sortThresholdTypes,
  sortThresholds,
} from '../../src/funding/balances.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';
import { withSkipReview } from '../agent-utils.js';

enum UserReview {
  AcceptAllProposed = 'allProposed',
  KeepAllCurrent = 'allCurrent',
  Manual = 'manual',
}
const LOW_PROPOSED_THRESHOLD_FACTOR = 0.5;

async function main() {
  const { skipReview } = await withSkipReview(yargs(process.argv.slice(2)))
    .argv;

  const dailyBurn: ChainMap<number> = rawDailyBurn;
  const desiredRelayerBalanceOverrides: ChainMap<number> =
    rawDesiredRelayerBalanceOverrides;
  const currentThresholds = readAllThresholds();

  const updatedThresholds = {} as ThresholdsData;
  for (const thresholdType of Object.values(BalanceThresholdType)) {
    updatedThresholds[thresholdType] = {};
  }

  // go through each chain, calculate the new thresholds and update the config
  for (const chain of Object.keys(dailyBurn)) {
    const currentChainThresholds = getCurrentChainThresholds(
      chain,
      currentThresholds,
    );

    const newChainThresholds = await processChainThresholds(
      chain,
      dailyBurn[chain],
      currentChainThresholds,
      skipReview,
      desiredRelayerBalanceOverrides[chain],
    );

    for (const thresholdType of Object.values(BalanceThresholdType)) {
      if (newChainThresholds[thresholdType] !== undefined) {
        updatedThresholds[thresholdType][chain] =
          newChainThresholds[thresholdType];
      }
    }
  }

  for (const thresholdType of Object.values(BalanceThresholdType)) {
    updatedThresholds[thresholdType] = sortThresholds(
      updatedThresholds[thresholdType],
    );
  }

  writeConfigsToFile(updatedThresholds);
  rootLogger.info('All chain thresholds have been updated successfully.');
}

async function processChainThresholds(
  chain: string,
  chainDailyBurn: number,
  currentThresholds: Record<BalanceThresholdType, number>,
  skipReview: boolean,
  desiredRelayerBalanceOverride?: number,
): Promise<Record<BalanceThresholdType, number>> {
  const proposedThresholds = buildProposedThresholds(
    chainDailyBurn,
    desiredRelayerBalanceOverride,
  );

  const reviewNeeded =
    !skipReview &&
    checkIfReviewNeeded(
      proposedThresholds,
      currentThresholds,
      !!desiredRelayerBalanceOverride,
    );

  let finalThresholds: Record<BalanceThresholdType, number>;
  if (reviewNeeded) {
    finalThresholds = await handleUserReviews(
      chain,
      proposedThresholds,
      currentThresholds,
    );
  } else {
    finalThresholds = buildFinalThresholds(
      proposedThresholds,
      currentThresholds,
      !!desiredRelayerBalanceOverride,
    );
  }

  finalThresholds = await validateThresholdsInteractive(chain, finalThresholds);

  return finalThresholds;
}

// threshold building functions
function buildProposedThresholds(
  chainDailyBurn: number,
  desiredRelayerBalanceOverride?: number,
): Record<BalanceThresholdType, number> {
  const proposed = {} as Record<BalanceThresholdType, number>;
  let burn = chainDailyBurn;
  // use the override to reset the burn value
  if (desiredRelayerBalanceOverride !== undefined) {
    burn = desiredRelayerBalanceOverride / RELAYER_BALANCE_TARGET_DAYS;
  }

  for (const thresholdType of Object.values(BalanceThresholdType)) {
    // SPECIAL CASE: If the override is 0, this is either
    // 1) a new chain, we need to set the desired relayer balance and we set it to 0, but we don't want to set any alerts yet
    // 2) a special case where the relayer will have no use (osmosis), we don't want to set any alerts
    if (
      desiredRelayerBalanceOverride === 0 &&
      thresholdType !== BalanceThresholdType.DesiredRelayerBalance
    ) {
      // skip alerting for this chain
      continue;
    }

    proposed[thresholdType] = formatBalanceThreshold(
      burn *
        balanceThresholdConfigMapping[thresholdType].dailyRelayerBurnMultiplier,
    );
  }

  return proposed;
}

function checkIfReviewNeeded(
  proposed: Record<BalanceThresholdType, number>,
  currentThresholds: Record<BalanceThresholdType, number>,
  overrideForChain: boolean,
): boolean {
  // If we have an override, we want to always accept the proposed values
  if (overrideForChain) return false;

  // if any of the proposed values are less than (LOW_PROPOSED_THRESHOLD_FACTOR)x of the current, we want to review all thresholds for that chain
  for (const thresholdType of Object.keys(proposed) as BalanceThresholdType[]) {
    if (
      currentThresholds[thresholdType] &&
      proposed[thresholdType] <
        currentThresholds[thresholdType] * LOW_PROPOSED_THRESHOLD_FACTOR
    ) {
      return true;
    }
  }
  return false;
}

function buildFinalThresholds(
  proposed: Record<BalanceThresholdType, number>,
  currentThresholds: Record<BalanceThresholdType, number>,
  overrideForChain: boolean,
): Record<BalanceThresholdType, number> {
  // If we have an override, we want to always accept the proposed values
  if (overrideForChain) return proposed;

  const finalThresholds = proposed;
  // only use the proposed values if they are greater than the current
  for (const thresholdType of Object.keys(proposed) as BalanceThresholdType[]) {
    if (currentThresholds[thresholdType]) {
      finalThresholds[thresholdType] = Math.max(
        currentThresholds[thresholdType],
        proposed[thresholdType],
      );
    }
  }

  return finalThresholds;
}

// review and validation functions
async function handleUserReviews(
  chain: string,
  proposedThresholds: Record<BalanceThresholdType, number>,
  currentThresholds: Record<BalanceThresholdType, number>,
): Promise<Record<BalanceThresholdType, number>> {
  rootLogger.info(
    `\n*** Chain "${chain}": Some proposed thresholds are >50% lower than the current. ***\n`,
  );

  printChainThresholds(currentThresholds, proposedThresholds);

  const selectedChoice = await select({
    message: `[${chain}] These thresholds have a >50% reduction. How would you like to handle them?`,
    choices: [
      {
        name: 'Accept ALL Proposed values',
        value: UserReview.AcceptAllProposed,
      },
      { name: 'Keep ALL Current values', value: UserReview.KeepAllCurrent },
      {
        name: 'Manual: Decide individually for each threshold',
        value: UserReview.Manual,
      },
    ],
  });

  switch (selectedChoice) {
    case UserReview.AcceptAllProposed:
      return proposedThresholds;
    case UserReview.KeepAllCurrent:
      rootLogger.warn(
        `Consider adding ${chain} to the desiredRelayerBalanceOverrides.json file, so that you are not prompted to review the thresholds in the future.`,
      );
      return currentThresholds;
    case UserReview.Manual:
      return interactiveThresholdUpdate(currentThresholds, proposedThresholds);
  }
}

async function validateThresholdsInteractive(
  chain: string,
  chainThresholds: Record<BalanceThresholdType, number>,
): Promise<Record<BalanceThresholdType, number>> {
  let isValid = false;
  let thresholds = { ...chainThresholds };

  while (!isValid) {
    const errors = checkForThresholdErrors(thresholds);

    if (errors.length === 0) {
      isValid = true;
    } else {
      rootLogger.warn(`Validation failed for chain "${chain}":`);
      errors.forEach((err) => rootLogger.warn(err));

      thresholds = await interactiveThresholdUpdate(thresholds);
    }
  }

  return thresholds;
}

function printChainThresholds(
  currentThresholds: Record<BalanceThresholdType, number>,
  proposedThresholds?: Record<BalanceThresholdType, number>,
) {
  const currentTypes = sortThresholdTypes(
    Object.keys(currentThresholds) as BalanceThresholdType[],
  ).reverse();

  const reviewTable = currentTypes.map((thresholdType) => {
    const data: {
      ThresholdType: string;
      Current: number;
      Proposed?: number;
    } = {
      ThresholdType: thresholdType,
      Current: currentThresholds[thresholdType as BalanceThresholdType],
    };
    if (proposedThresholds) {
      data.Proposed = proposedThresholds[thresholdType as BalanceThresholdType];
    }
    return data;
  });
  console.table(reviewTable);
}

async function interactiveThresholdUpdate(
  chainThresholds: Record<BalanceThresholdType, number>,
  proposedThresholds?: Record<BalanceThresholdType, number>,
): Promise<Record<BalanceThresholdType, number>> {
  let newThresholds = { ...chainThresholds };

  const doneOption = 'done';

  // function that generates the options, it's dynamic as it depends on the current thresholds which can change
  // as the user updates them
  const thresholdOptions = (
    thresholds: Record<BalanceThresholdType, number>,
  ) => {
    const sortedThresholdTypes = sortThresholdTypes(
      Object.keys(thresholds) as BalanceThresholdType[],
    ).reverse();

    const options: {
      name: string;
      value: BalanceThresholdType | string;
    }[] = sortedThresholdTypes.map((thresholdType) => ({
      name: `Edit [${thresholdType}] (current = ${
        thresholds[thresholdType as BalanceThresholdType]
      })`,
      value: thresholdType,
    }));
    options.push({ name: 'Done editing', value: doneOption });

    return options;
  };

  let finished = false;
  while (!finished) {
    printChainThresholds(newThresholds, proposedThresholds);

    // select a threshold to edit
    const choice = await select<BalanceThresholdType | string>({
      message: `Select a threshold to edit or 'Done editing':`,
      choices: thresholdOptions(newThresholds),
    });

    if (choice === doneOption) {
      finished = true;
    } else {
      const manualThresholdInput = await input({
        message: `Enter new threshold for [${choice}]`,
        validate: (input) =>
          isNaN(parseFloat(input)) ? 'Must be a number' : true,
      });

      const typedChoice = choice as BalanceThresholdType;

      newThresholds = {
        ...newThresholds,
        [typedChoice]: formatBalanceThreshold(parseFloat(manualThresholdInput)),
      };
    }
  }

  return newThresholds;
}

function writeConfigsToFile(newConfigs: ThresholdsData) {
  for (const thresholdType of Object.values(BalanceThresholdType)) {
    const fileName =
      balanceThresholdConfigMapping[thresholdType].configFileName;
    const configPath = `${THRESHOLD_CONFIG_PATH}/${fileName}`;

    try {
      rootLogger.info(
        `Writing updated thresholds for ${thresholdType} => ${fileName}`,
      );
      writeJsonAtPath(configPath, newConfigs[thresholdType]);
    } catch (error) {
      rootLogger.error(`Failed to write config for ${thresholdType}:`, error);
    }
  }
}

main().catch((e) => {
  rootLogger.error(e);
  process.exit(1);
});
