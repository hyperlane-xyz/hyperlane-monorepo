import { ethers } from 'ethers';
import yargs from 'yargs';

import { ChainName, MultiProvider, objMap } from '@abacus-network/sdk';

import { EnvironmentConfig } from './config';

export function getArgs() {
  return yargs(process.argv.slice(2))
    .alias('e', 'env')
    .describe('e', 'deploy environment')
    .help('h')
    .alias('h', 'help');
}

export async function getEnvironment(): Promise<string> {
  return (await getArgs().argv).e as Promise<string>;
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
