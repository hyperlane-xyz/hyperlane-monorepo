import { ethers } from 'ethers';
import yargs from 'yargs';

import {
  AbacusCore,
  ChainMap,
  ChainName,
  MultiProvider,
  objMap,
} from '@abacus-network/sdk';

import { EnvironmentConfig, TransactionConfig } from './config';
import { RouterConfig } from './router';

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

export function getRouterConfig<N extends ChainName>(
  core: AbacusCore<N>,
): ChainMap<N, RouterConfig> {
  return objMap(core.contractsMap, (_, coreContacts) => ({
    abacusConnectionManager:
      coreContacts.contracts.abacusConnectionManager.address,
  }));
}

// this is currently a kludge to account for ethers issues
function fixOverrides(config: TransactionConfig): ethers.Overrides {
  if (config.supports1559) {
    return {
      maxFeePerGas: config.overrides?.maxFeePerGas,
      maxPriorityFeePerGas: config.overrides?.maxPriorityFeePerGas,
      gasLimit: config.overrides?.gasLimit,
    };
  } else {
    return {
      type: 0,
      gasPrice: config.overrides?.gasPrice,
      gasLimit: config.overrides?.gasLimit,
    };
  }
}

export const registerEnvironment = <Chain extends ChainName>(
  multiProvider: MultiProvider<Chain>,
  environmentConfig: EnvironmentConfig<Chain>,
) => {
  multiProvider.apply((chain, dc) => {
    const txConfig = environmentConfig[chain];
    dc.registerOverrides(fixOverrides(txConfig));
    if (txConfig.confirmations) {
      dc.registerConfirmations(txConfig.confirmations);
    }
    if (txConfig.signer) {
      dc.registerSigner(txConfig.signer);
    }
  });
};

export const registerSigners = <Chain extends ChainName>(
  multiProvider: MultiProvider,
  signers: ChainMap<Chain, ethers.Signer>,
) =>
  objMap(signers, (chain, signer) =>
    multiProvider.getChainConnection(chain).registerSigner(signer),
  );

export const registerSigner = <Chain extends ChainName>(
  multiProvider: MultiProvider<Chain>,
  signer: ethers.Signer,
) => multiProvider.apply((_, dc) => dc.registerSigner(signer));

export const getMultiProviderFromConfigAndSigner = <Chain extends ChainName>(
  environmentConfig: EnvironmentConfig<Chain>,
  signer: ethers.Signer,
): MultiProvider<Chain> => {
  const chainProviders = objMap(environmentConfig, () => ({
    provider: signer.provider!,
    signer,
  }));
  const multiProvider = new MultiProvider(chainProviders);
  registerEnvironment(multiProvider, environmentConfig);
  return multiProvider;
};
