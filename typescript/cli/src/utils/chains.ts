import { Separator, checkbox } from '@inquirer/prompts';
import select from '@inquirer/select';
import chalk from 'chalk';

import {
  ChainMap,
  ChainMetadata,
  mainnetChainsMetadata,
  testnetChainsMetadata,
} from '@hyperlane-xyz/sdk';

import { log, logBlue } from '../../logger.js';

// A special value marker to indicate user selected
// a new chain in the list
const NEW_CHAIN_MARKER = '__new__';

export async function runOriginAndRemotesSelectionStep(
  customChains: ChainMap<ChainMetadata>,
) {
  const origin = await runSingleChainSelectionStep(
    customChains,
    'Select origin chain (the chain to which you will deploy now)',
  );
  const remotes = await runMultiChainSelectionStep(
    customChains,
    'Select remote chains the origin will send messages to',
  );
  return { origin, remotes };
}

export async function runSingleChainSelectionStep(
  customChains: ChainMap<ChainMetadata>,
  message = 'Select chain',
) {
  const choices = getChainChoices(customChains);
  const origin = (await select({
    message,
    choices,
    pageSize: 20,
  })) as string;
  handleNewChain([origin]);
  return origin;
}

export async function runMultiChainSelectionStep(
  customChains: ChainMap<ChainMetadata>,
  message = 'Select chains',
) {
  const choices = getChainChoices(customChains);
  const remotes = (await checkbox({
    message,
    choices,
    pageSize: 20,
  })) as string[];
  handleNewChain(remotes);
  if (!remotes?.length) throw new Error('No remote chains selected');
  return remotes;
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
