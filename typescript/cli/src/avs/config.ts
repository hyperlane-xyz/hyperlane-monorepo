import { type ChainMap } from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

interface AVSContracts {
  avsDirectory: Address;
  delegationManager: Address;
  proxyAdmin: Address;
  ecdsaStakeRegistry: Address;
  hyperlaneServiceManager: Address;
}

// TODO: move to registry
export const avsAddresses: ChainMap<AVSContracts> = {
  ethereum: {
    avsDirectory: '0x135dda560e946695d6f155dacafc6f1f25c1f5af',
    delegationManager: '0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A',
    proxyAdmin: '0x75EE15Ee1B4A75Fa3e2fDF5DF3253c25599cc659',
    ecdsaStakeRegistry: '0x272CF0BB70D3B4f79414E0823B426d2EaFd48910',
    hyperlaneServiceManager: '0xe8E59c6C8B56F2c178f63BCFC4ce5e5e2359c8fc',
  },
};
