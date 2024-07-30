import select from '@inquirer/select';
import chalk from 'chalk';
import prompts from 'prompts';

import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';

import { log, logTip } from '../logger.js';

import { calculatePageSize } from './cli-options.js';

// A special value marker to indicate user selected
// a new chain in the list
const NEW_CHAIN_MARKER = '__new__';

export async function runSingleChainSelectionStep(
  chainMetadata: ChainMap<ChainMetadata>,
  message = 'Select chain',
) {
  const choices = getChainChoices(chainMetadata);
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
  requireMultiple = false,
) {
  const choices = getChainChoices(chainMetadata);
  while (true) {
    logTip('Use SPACE key to select chains, then press ENTER to confirm');
    const chains = (await prompts({
      type: 'multiselect',
      name: 'chains',
      message,
      choices,
      limit: calculatePageSize(2),
      min: requireMultiple ? 2 : 1,
    })) as string[];
    handleNewChain(chains);
    return chains;
  }
}

function getChainChoices(
  chainMetadata: ChainMap<ChainMetadata>,
): prompts.Choice[] {
  const chainsToChoices = (chains: ChainMetadata[]): prompts.Choice[] =>
    chains.map((c) => ({ title: c.name, value: c.name }));

  const chains = Object.values(chainMetadata);
  const testnetChains = chains.filter((c) => !!c.isTestnet);
  const mainnetChains = chains.filter((c) => !c.isTestnet);
  const choices: prompts.Choice[] = [
    { title: '(New custom chain)', value: NEW_CHAIN_MARKER },
    { title: '--Mainnet Chains--', value: '', disable: true },
    ...chainsToChoices(mainnetChains),
    { title: '--Testnet Chains--', value: '', disable: true },
    ...chainsToChoices(testnetChains),
  ];
  return choices;
}

function handleNewChain(chainNames: string[]) {
  if (chainNames.includes(NEW_CHAIN_MARKER)) {
    log(
      chalk.blue('Use the'),
      chalk.magentaBright('hyperlane config create'),
      chalk.blue('command to create new configs'),
    );
    process.exit(0);
  }
}
