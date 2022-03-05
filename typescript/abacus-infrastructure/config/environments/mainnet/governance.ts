import { GovernanceConfigWithoutCore } from '../../../src/governance';

export const governance: GovernanceConfigWithoutCore = {
  recoveryTimelock: 60 * 60 * 24 * 14, // 14 days
  addresses: {
    avalanche: {
      recoveryManager: '0x8a11d528d12ea09ccbf86e21B7813812b53a6900',
    },
    celo: {
      recoveryManager: '0x070c2843402Aa0637ae0F2E2edf601aAB5E72509',
      governor: '0x070c2843402Aa0637ae0F2E2edf601aAB5E72509',
    },
    ethereum: {
      recoveryManager: '0x2bb2a5a724170357cb691841f40d26a950d8c33d',
    },
    polygon: {
      recoveryManager: '0x8A1405C70c8a45177b5ac71b1d22779272E5d48b',
    },
  },
};
