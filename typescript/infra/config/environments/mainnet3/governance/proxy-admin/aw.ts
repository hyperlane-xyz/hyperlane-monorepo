import { ChainMap } from '@hyperlane-xyz/sdk';
import { awSafes } from '../safe/aw.js';
import { awIcas } from '../ica/aw.js';
import { Address } from '@hyperlane-xyz/utils';

export const awProxyAdmins: ChainMap<{ address: Address; owner: Address }> = {
  ethereum: {
    address: '0x692e50577fAaBF10F824Dc8Ce581e3Af93785175',
    owner: awSafes.ethereum,
  },
  arbitrum: {
    address: '0x33465314CbD880976B7A9f86062d615DE5E4Fa8A',
    owner: awSafes.arbitrum,
  },
  bsc: {
    address: '0x9C5a42CBA06D818945df8D798C98F41EA1d88BDA',
    owner: awSafes.bsc,
  },
  plasma: {
    address: '0x0587E4E093Cd820eda59EcF0FD73544cE65B4775',
    owner: awSafes.plasma,
  },
  tron: {
    address: '0x0d558DbF548fB9df2b62740b8a4C79A7160971DB',
    owner: awIcas.tron, // owned by Ethereum Safe
  },
} as const;
