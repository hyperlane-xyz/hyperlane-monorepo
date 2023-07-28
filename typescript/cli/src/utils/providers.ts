import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  MultiProvider,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

export function getMultiProvider(
  customChains: ChainMap<ChainMetadata>,
  signer?: ethers.Signer,
) {
  const chainConfigs = { ...chainMetadata, ...customChains };
  const mp = new MultiProvider(chainConfigs);
  if (signer) mp.setSharedSigner(signer);
  return mp;
}
