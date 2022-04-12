import { CoreConfig } from '../../../src/core';

export const core: CoreConfig = {
  multisigValidatorManagers: {
    // Hardhat accounts 1-4
    alfajores: {
      validatorSet: ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8'],
      quorumThreshold: 1,
    },
    fuji: {
      validatorSet: ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'],
      quorumThreshold: 1,
    },
    kovan: {
      validatorSet: ['0x90f79bf6eb2c4f870365e785982e1f101e93b906'],
      quorumThreshold: 1,
    },
    mumbai: {
      validatorSet: ['0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'],
      quorumThreshold: 1,
    },
  },
};
