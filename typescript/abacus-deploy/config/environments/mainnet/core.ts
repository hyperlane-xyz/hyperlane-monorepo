import { CoreConfig } from '../../../src/core';

export const core: CoreConfig = {
  processGas: 850_000,
  reserveGas: 15_000,
  validators: {
    avalanche: '0x6e29236E86a039F8225834F7E7cd4122dc166e51',
    celo: '0x703643995262c92ab013E3CCA810BdcB9239d45a',
    ethereum: '0x5Ef6e0F6A7E1f866612D806041799a9D762b62c0',
    polygon: '0x65Fb23bDaD54574713AD756EFE16ce2eEb1F5855',
  },
};
