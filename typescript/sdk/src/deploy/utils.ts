import { ethers } from 'ethers';

import { types } from '@abacus-network/utils';

import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils';

import { EnvironmentConfig } from './types';

export function getMultiProviderFromConfigAndProvider<Chain extends ChainName>(
  environmentConfig: EnvironmentConfig<Chain>,
  provider: ethers.providers.Provider,
): MultiProvider<Chain> {
  const chainProviders = objMap(environmentConfig, (_, config) => ({
    provider,
    confirmations: config.confirmations,
    overrides: config.overrides,
  }));
  return new MultiProvider(chainProviders);
}

export function getMultiProviderFromConfigAndSigner<Chain extends ChainName>(
  environmentConfig: EnvironmentConfig<Chain>,
  signer: ethers.Signer,
): MultiProvider<Chain> {
  const chainProviders = objMap(environmentConfig, (_, config) => ({
    provider: signer.provider!,
    signer,
    confirmations: config.confirmations,
    overrides: config.overrides,
  }));
  return new MultiProvider(chainProviders);
}

export function getChainToOwnerMap<Chain extends ChainName>(
  configMap: ChainMap<Chain, any>,
  owner: types.Address,
): ChainMap<Chain, { owner: string }> {
  return objMap(configMap, () => {
    return {
      owner,
    };
  });
}
