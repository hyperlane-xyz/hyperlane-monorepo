import { ethers } from 'ethers';
import yargs from 'yargs';

import { ChainName, MultiProvider, objMap } from '@abacus-network/sdk';

import { EnvironmentConfig } from './config';

export function getArgs() {
  return yargs(process.argv.slice(2))
    .alias('e', 'env')
    .describe('e', 'deploy environment')
    .string('e')
    .alias('context', 'deploy-context')
    .string('context')
    .default('context', 'abacus')
    .help('h')
    .alias('h', 'help');
}

export async function getEnvironment(): Promise<string> {
  return (await getArgs().argv).e as string;
}

export async function getContext(): Promise<string> {
  return (await getArgs().argv).context as string;
}

export const getMultiProviderFromConfigAndSigner = <Chain extends ChainName>(
  environmentConfig: EnvironmentConfig<Chain>,
  signer: ethers.Signer,
): MultiProvider<Chain> => {
  const chainProviders = objMap(environmentConfig, (_, config) => ({
    provider: signer.provider!,
    signer,
    confirmations: config.confirmations,
    overrides: config.overrides,
  }));
  return new MultiProvider(chainProviders);
};

// Returns a \ b
// Taken from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set#implementing_basic_set_operations
export function setDifference<T>(a: Set<T>, b: Set<T>) {
  const diff = new Set(a);
  for (const element of b) {
    diff.delete(element);
  }
  return diff;
}
