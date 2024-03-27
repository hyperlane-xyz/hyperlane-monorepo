import { Separator, checkbox } from '@inquirer/prompts';
import select from '@inquirer/select';
import chalk from 'chalk';

import {
  ChainMap,
  ChainMetadata,
  mainnetChainsMetadata,
  testnetChainsMetadata,
} from '@hyperlane-xyz/sdk';

import { log, logBlue, logRed, logTip } from '../logger.js';

// A special value marker to indicate user selected
// a new chain in the list
const NEW_CHAIN_MARKER = '__new__';

export async function runSingleChainSelectionStep(
  customChains: ChainMap<ChainMetadata>,
  message = 'Select chain',
) {
  const choices = getChainChoices(customChains);
  const chain = (await select({
    message,
    choices,
    pageSize: 20,
  })) as string;
  handleNewChain([chain]);
  return chain;
}

export async function runMultiChainSelectionStep(
  customChains: ChainMap<ChainMetadata>,
  message = 'Select chains',
  requireMultiple = false,
) {
  const choices = getChainChoices(customChains);
  while (true) {
    logTip('Use SPACE key to select chains, then press ENTER');
    const chains = (await checkbox({
      message,
      choices,
      pageSize: 20,
    })) as string[];
    handleNewChain(chains);
    if (requireMultiple && chains?.length < 2) {
      logRed('Please select at least 2 chains');
      continue;
    }
    return chains;
  }
}

function getChainChoices(customChains: ChainMap<ChainMetadata>) {
  const chainsToChoices = (chains: ChainMetadata[]) =>
    chains.map((c) => ({ name: c.name, value: c.name }));
  const choices: Parameters<typeof select>['0']['choices'] = [
    new Separator('--Custom Chains--'),
    ...chainsToChoices(Object.values(customChains)),
    { name: '(New custom chain)', value: NEW_CHAIN_MARKER },
    new Separator('--Mainnet Chains--'),
    ...chainsToChoices(mainnetChainsMetadata),
    new Separator('--Testnet Chains--'),
    ...chainsToChoices(testnetChainsMetadata),
  ];
  return choices;
}

function handleNewChain(chainNames: string[]) {
  if (chainNames.includes(NEW_CHAIN_MARKER)) {
    logBlue(
      'To use a new chain, use the --config argument add them to that file',
    );
    log(
      chalk.blue('Use the'),
      chalk.magentaBright('hyperlane config create'),
      chalk.blue('command to create new configs'),
    );
    process.exit(0);
  }
}
