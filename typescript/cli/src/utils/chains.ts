import { Separator, checkbox } from '@inquirer/prompts';
import select from '@inquirer/select';
import chalk from 'chalk';

import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';

import { log, logRed, logTip } from '../logger.js';

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
    pageSize: 30,
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
    logTip('Use SPACE key to select chains, then press ENTER');
    const chains = (await checkbox({
      message,
      choices,
      pageSize: 30,
    })) as string[];
    handleNewChain(chains);
    if (requireMultiple && chains?.length < 2) {
      logRed('Please select at least 2 chains');
      continue;
    }
    return chains;
  }
}

function getChainChoices(chainMetadata: ChainMap<ChainMetadata>) {
  const chainsToChoices = (chains: ChainMetadata[]) =>
    chains.map((c) => ({ name: c.name, value: c.name }));

  const chains = Object.values(chainMetadata);
  const testnetChains = chains.filter((c) => !!c.isTestnet);
  const mainnetChains = chains.filter((c) => !c.isTestnet);
  const choices: Parameters<typeof select>['0']['choices'] = [
    { name: '(New custom chain)', value: NEW_CHAIN_MARKER },
    new Separator('--Mainnet Chains--'),
    ...chainsToChoices(mainnetChains),
    new Separator('--Testnet Chains--'),
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
