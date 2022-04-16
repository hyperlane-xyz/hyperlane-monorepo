import { CoreConfig } from '../../../src/core';

const validatorManagers = {
  // Hardhat accounts 1-4
  alfajores: {
    validators: ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8'],
    threshold: 1,
  },
  fuji: {
    validators: ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'],
    threshold: 1,
  },
  kovan: {
    validators: ['0x90f79bf6eb2c4f870365e785982e1f101e93b906'],
    threshold: 1,
  },
  mumbai: {
    validators: ['0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'],
    threshold: 1,
  },
};

// TODO: fix type inference
export const core: CoreConfig<keyof typeof validatorManagers> = {
  validatorManagers,
};
