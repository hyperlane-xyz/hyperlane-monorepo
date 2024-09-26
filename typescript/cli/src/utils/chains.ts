import { Separator, confirm } from '@inquirer/prompts';
import select from '@inquirer/select';
import chalk from 'chalk';

import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { toTitleCase } from '@hyperlane-xyz/utils';

import { log, logTip } from '../logger.js';

import { calculatePageSize } from './cli-options.js';
import { searchableCheckBox } from './input.js';

// A special value marker to indicate user selected
// a new chain in the list
const NEW_CHAIN_MARKER = '__new__';

export async function runSingleChainSelectionStep(
  chainMetadata: ChainMap<ChainMetadata>,
  message = 'Select chain',
) {
  const networkType = await selectNetworkType();
  const choices = getChainChoices(chainMetadata, networkType);
  const chain = (await select({
    message,
    choices,
    pageSize: calculatePageSize(2),
  })) as string;
  handleNewChain([chain]);
  return chain;
}

export async function runMultiChainSelectionStep(
  chainMetadata: ChainMap<ChainMetadata>,
  message = 'Select chains',
  requireNumber = 0,
  requiresConfirmation = false,
) {
  const networkType = await selectNetworkType();
  const choices = getChainChoices(chainMetadata, networkType);

  let currentChoiceSelection = new Set();
  while (true) {
    logTip(
      `Use TAB key to select at least ${requireNumber} chains, then press ENTER`,
    );
    const chains = (await searchableCheckBox({
      message,
      choices: choices.map((choice) =>
        !Separator.isSeparator(choice) &&
        currentChoiceSelection.has(choice.name)
          ? { ...choice, checked: true }
          : choice,
      ),
      pageSize: calculatePageSize(2),
      validate: (answer): string | boolean => {
        if (answer.length < requireNumber) {
          return `Please select at least ${requireNumber} chains`;
        }

        return true;
      },
    })) as string[];

    handleNewChain(chains);

    const confirmed = !requiresConfirmation
      ? true
      : await confirm({
          message: `Is this chain selection correct?: ${chalk.cyan(
            chains.join(', '),
          )}`,
        });
    if (!confirmed) {
      currentChoiceSelection = new Set(chains);
      continue;
    }

    return chains;
  }
}

async function selectNetworkType() {
  const networkType = await select({
    message: 'Select network type',
    choices: [
      { name: 'Mainnet', value: 'mainnet' },
      { name: 'Testnet', value: 'testnet' },
    ],
  });
  return networkType as 'mainnet' | 'testnet';
}

function getChainChoices(
  chainMetadata: ChainMap<ChainMetadata>,
  networkType: 'mainnet' | 'testnet',
) {
  const chainsToChoices = (chains: ChainMetadata[]) =>
    chains.map((c) => ({ name: c.name, value: c.name }));

  const chains = Object.values(chainMetadata);
  const filteredChains = chains.filter((c) =>
    networkType === 'mainnet' ? !c.isTestnet : !!c.isTestnet,
  );
  const choices: Parameters<typeof select>['0']['choices'] = [
    { name: '(New custom chain)', value: NEW_CHAIN_MARKER },
    new Separator(`--${toTitleCase(networkType)} Chains--`),
    ...chainsToChoices(filteredChains),
  ];
  return choices;
}

function handleNewChain(chainNames: string[]) {
  if (chainNames.includes(NEW_CHAIN_MARKER)) {
    log(
      chalk.blue('Use the'),
      chalk.magentaBright('hyperlane registry init'),
      chalk.blue('command to create new configs'),
    );
    process.exit(0);
  }
}
