import { CoreConfig } from '../../../src/config/core';
import { DeployEnvironment } from '../../../src/deploy';

export const core: CoreConfig = {
  environment: DeployEnvironment.mainnet,
  recoveryTimelock: 60 * 60 * 24 * 14, // 14 days
  processGas: 850_000,
  reserveGas: 15_000,
  addresses: {
    avalanche: {
      validator: '0x6e29236E86a039F8225834F7E7cd4122dc166e51',
      recoveryManager: '0x8a11d528d12ea09ccbf86e21B7813812b53a6900',
    },
    celo: {
      recoveryManager: '0x070c2843402Aa0637ae0F2E2edf601aAB5E72509',
      validator: '0x703643995262c92ab013E3CCA810BdcB9239d45a',
      governor: '0x070c2843402Aa0637ae0F2E2edf601aAB5E72509',
    },
    ethereum: {
      validator: '0x5Ef6e0F6A7E1f866612D806041799a9D762b62c0',
      recoveryManager: '0x2bb2a5a724170357cb691841f40d26a950d8c33d',
    },
    polygon: {
      validator: '0x65Fb23bDaD54574713AD756EFE16ce2eEb1F5855',
      recoveryManager: '0x8A1405C70c8a45177b5ac71b1d22779272E5d48b',
    },
  },
};
