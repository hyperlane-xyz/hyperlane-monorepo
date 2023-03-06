import {
  ChainMap,
  CoreConfig,
  GasOracleContractType,
  MultisigIsmConfig,
  objMap,
} from '@hyperlane-xyz/sdk';

import { TestChains, chainNames } from './chains';

function getGasOracles(local: TestChains) {
  return Object.fromEntries(
    chainNames
      .filter((name) => name !== local)
      .map((name) => [name, GasOracleContractType.StorageGasOracle]),
  );
}

// Owner is hardhat account 0
export const owner = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// Validators are hardhat accounts 1-3
export const multisigIsmConfig: ChainMap<MultisigIsmConfig> = {
  test1: {
    validators: ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8'],
    threshold: 1,
  },
  test2: {
    validators: ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'],
    threshold: 1,
  },
  test3: {
    validators: ['0x90f79bf6eb2c4f870365e785982e1f101e93b906'],
    threshold: 1,
  },
};

export const core: ChainMap<CoreConfig> = objMap(multisigIsmConfig, (chain) => {
  return {
    owner: owner,
    multisigIsm: Object.fromEntries(
      Object.entries(multisigIsmConfig).filter(([key]) => key !== chain),
    ),
    igp: {
      beneficiary: owner,
      gasOracles: getGasOracles(chain),
    },
  };
});
