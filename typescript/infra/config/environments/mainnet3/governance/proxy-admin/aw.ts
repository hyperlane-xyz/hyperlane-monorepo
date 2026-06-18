import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { chainOwners } from '../../owners.js';
import { awIcas } from '../ica/aw.js';
import { awSafes } from '../safe/aw.js';

// Fall back to the chain's governance owner when an AW safe entry has been
// removed (e.g. a deprecated/unused safe commented out of awSafes), so a missing
// entry never yields an undefined proxy-admin owner.
const ownerOrFallback = (
  safe: Address | undefined,
  fallback: Address,
): Address => safe ?? fallback;

export const awProxyAdmins: ChainMap<{ address: Address; owner: Address }> = {
  ethereum: {
    address: '0x692e50577fAaBF10F824Dc8Ce581e3Af93785175',
    owner: ownerOrFallback(awSafes.ethereum, chainOwners.ethereum.owner),
  },
  arbitrum: {
    address: '0x33465314CbD880976B7A9f86062d615DE5E4Fa8A',
    owner: ownerOrFallback(awSafes.arbitrum, chainOwners.arbitrum.owner),
  },
  bsc: {
    address: '0x9C5a42CBA06D818945df8D798C98F41EA1d88BDA',
    owner: ownerOrFallback(awSafes.bsc, chainOwners.bsc.owner),
  },
  plasma: {
    address: '0x0587E4E093Cd820eda59EcF0FD73544cE65B4775',
    owner: ownerOrFallback(awSafes.plasma, chainOwners.plasma.owner),
  },
  tron: {
    address: '0x0d558DbF548fB9df2b62740b8a4C79A7160971DB',
    owner: awIcas.tron, // owned by Ethereum Safe
  },
};
