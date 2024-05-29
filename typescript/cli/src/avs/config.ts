import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

interface AVSContracts {
  avsDirectory: Address;
  proxyAdmin: Address;
  ecdsaStakeRegistry: Address;
  hyperlaneServiceManager: Address;
}

// TODO: move to registry
export const avsAddresses: ChainMap<AVSContracts> = {
  holesky: {
    avsDirectory: '0x055733000064333CaDDbC92763c58BF0192fFeBf',
    proxyAdmin: '0x33dB966328Ea213b0f76eF96CA368AB37779F065',
    ecdsaStakeRegistry: '0xFfa913705484C9BAea32Ffe9945BeA099A1DFF72',
    hyperlaneServiceManager: '0xc76E477437065093D353b7d56c81ff54D167B0Ab',
  },
};
