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
    proxyAdmin: '0x1b33611fCc073aB0737011d5512EF673Bff74962',
    ecdsaStakeRegistry: '0x20c44b1E3BeaDA1e9826CFd48BeEDABeE9871cE9',
    hyperlaneServiceManager: '0xeAEfB1458b032e75de3e9A3a480d005c426FB1c5',
  },
};
