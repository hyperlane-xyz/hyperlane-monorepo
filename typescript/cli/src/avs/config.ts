import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

interface AVSContracts {
  avsDirectory: Address;
  delegationManager: Address;
  proxyAdmin: Address;
  ecdsaStakeRegistry: Address;
  hyperlaneServiceManager: Address;
}

// TODO: move to registry
export const avsAddresses: ChainMap<AVSContracts> = {
  holesky: {
    avsDirectory: '0x055733000064333CaDDbC92763c58BF0192fFeBf',
    delegationManager: '0xA44151489861Fe9e3055d95adC98FbD462B948e7',
    proxyAdmin: '0x33dB966328Ea213b0f76eF96CA368AB37779F065',
    ecdsaStakeRegistry: '0xFfa913705484C9BAea32Ffe9945BeA099A1DFF72',
    hyperlaneServiceManager: '0xc76E477437065093D353b7d56c81ff54D167B0Ab',
  },
  ethereum: {
    avsDirectory: '0x135dda560e946695d6f155dacafc6f1f25c1f5af',
    delegationManager: '0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A',
    proxyAdmin: '0x75EE15Ee1B4A75Fa3e2fDF5DF3253c25599cc659',
    ecdsaStakeRegistry: '0x272CF0BB70D3B4f79414E0823B426d2EaFd48910',
    hyperlaneServiceManager: '0xe8E59c6C8B56F2c178f63BCFC4ce5e5e2359c8fc',
  },
};
