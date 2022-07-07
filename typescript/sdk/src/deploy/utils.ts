import { ethers } from 'ethers';

import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';
import { objMap } from '../utils';

import { EnvironmentConfig } from './types';

export function getMultiProviderFromConfigAndSigner<Chain extends ChainName>(
  environmentConfig: EnvironmentConfig<Chain>,
  signer: ethers.Signer,
): MultiProvider<Chain> {
  const chainProviders = objMap(environmentConfig, (_, _config) => ({
    provider: signer.provider!,
    signer,
    confirmations: 0,
    // confirmations: config.confirmations,
    // overrides: config.overrides,
  }));
  return new MultiProvider(chainProviders);
}
