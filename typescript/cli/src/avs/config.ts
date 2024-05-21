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
    proxyAdmin: '0x11918DC33E067C5DA83EEF58E50F856398b8Df4C',
    ecdsaStakeRegistry: '0xFCc63b537e70652A280c4E7883C5BB5a1700e897',
    hyperlaneServiceManager: '0xb94F96D398eA5BAB5CA528EE9Fdc19afaA825818',
  },
};
