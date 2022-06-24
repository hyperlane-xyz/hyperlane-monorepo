import { ethers } from 'ethers';

import { MultiProvider } from '../providers/MultiProvider';
import type { TestChainNames } from '../types';

// TODO consider removing this
export function hardhatMultiProvider(
  provider: ethers.providers.Provider,
  signer?: ethers.Signer,
): MultiProvider<TestChainNames> {
  return new MultiProvider<TestChainNames>({
    test1: {
      provider,
      signer,
    },
    test2: {
      provider,
      signer,
    },
    test3: {
      provider,
      signer,
    },
  });
}
