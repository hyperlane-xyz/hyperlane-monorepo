import { CoreConfig } from '../../../src/core/CoreDeploy';

export const core: CoreConfig = {
  environment: 'mainnet',
  recoveryTimelock: 60 * 60 * 24 * 14, // 14 days
  optimisticSeconds: 60 * 30, // 30 minutes
  processGas: 850_000,
  reserveGas: 15_000,
  addresses: {
    avalanche: {
      updater: '0x6e29236E86a039F8225834F7E7cd4122dc166e51',
      watchers: ['0x74C1580f920E4d694502Ca95838d6382caecb1dE'],
      recoveryManager: '0x8a11d528d12ea09ccbf86e21B7813812b53a6900',
    },
    celo: {
      recoveryManager: '0x070c2843402Aa0637ae0F2E2edf601aAB5E72509',
      updater: '0x703643995262c92ab013E3CCA810BdcB9239d45a',
      watchers: ['0x97D510A1F9464d220E2716Cc52Cb03851D6d595c'],
    },
    ethereum: {
      updater: '0x5Ef6e0F6A7E1f866612D806041799a9D762b62c0',
      recoveryManager: '0x2bb2a5a724170357cb691841f40d26a950d8c33d',
      watchers: ['0xD0D09d9CF712ccE87141Dfa22a3aBBDb7B1c296e'],
    },
    polygon: {
      updater: '0x65Fb23bDaD54574713AD756EFE16ce2eEb1F5855',
      watchers: ['0x68015B84182c71F9c2EE6C8061405D6F1f56314B'],
      recoveryManager: '0x8A1405C70c8a45177b5ac71b1d22779272E5d48b',
    },
    governor: {
      name: 'celo',
      domain: chainJson.domain,
      address: '0x070c2843402Aa0637ae0F2E2edf601aAB5E72509',
    },
};
