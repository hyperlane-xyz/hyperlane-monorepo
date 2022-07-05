import { ethers } from 'ethers';

import { MultiProvider } from '../providers/MultiProvider';
import { IChainConnection, PartialChainMap } from '../types';
import { partialObjMap } from '../utils';

export function getMultiProviderFromConfigAndSigner(
  chainConfigs: PartialChainMap<IChainConnection>,
  signer: ethers.Signer,
): MultiProvider {
  const chainProviders = partialObjMap(chainConfigs, (_chain, config) => ({
    provider: signer.provider!,
    signer,
    confirmations: config.confirmations,
    overrides: config.overrides,
  }));
  return new MultiProvider(chainProviders);
}
