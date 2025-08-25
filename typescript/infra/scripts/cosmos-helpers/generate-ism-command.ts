import { Argv } from 'yargs';

import { defaultMultisigConfigs } from '@hyperlane-xyz/sdk';

import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

export function withCommandPrefix<T>(args: Argv<T>) {
  return args
    .describe(
      'commandPrefix',
      'The command for the Cosmos CLI, it will be prepended to the validators list to create an executable command.',
    )
    .example(
      'commandPrefix',
      './celestiad tx hyperlane ism create-merkle-root-multisig',
    )
    .alias('p', 'command-prefix')
    .default('commandPrefix', '');
}

/**
 * Generates the command(s) for the CosmosSDK CLI to deploy ISMs.
 */

async function main() {
  const { environment, chains, commandPrefix } = await withCommandPrefix(
    withChains(getArgs()),
  ).argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  if (chains == undefined) {
    throw new Error('Chains must be provided');
  }

  const validatorConfigs = chains.map((chain) => {
    const multisig = defaultMultisigConfigs[chain];
    if (!multisig) {
      throw Error(`No multisig config found for ${chain}`);
    }

    return {
      name: chain,
      domain_id: multiProvider.getDomainId(chain),
      // Sort addresses alphabetically
      addresses: multisig.validators.map(({ address }) => address).sort(),
      threshold: multisig.threshold,
    };
  });

  for (const entry of validatorConfigs) {
    console.log(`${entry.name}: ${entry.domain_id}`);
    console.log(
      `${commandPrefix} ${entry.addresses.join(',')} ${entry.threshold}`,
    );
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
