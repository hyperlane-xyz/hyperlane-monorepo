import { CoreConfig } from '../../../src/core';

export const core: CoreConfig = {
  processGas: 850_000,
  reserveGas: 15_000,
  validators: {
    // Hardhat accounts 1-4
    alfajores: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    fuji: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
    kovan: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
    mumbai: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  },
};
