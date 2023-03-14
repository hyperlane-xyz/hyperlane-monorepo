import {
  ChainMap,
  GasOracleContractType,
  IgpConfig,
  hyperlaneContractAddresses,
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
const OWNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

export const igp: ChainMap<IgpConfig> = Object.fromEntries(
  chainNames.map((chain) => {
    return [
      chain,
      {
        owner: OWNER_ADDRESS,
        beneficiary: OWNER_ADDRESS,
        gasOracleType: getGasOracles(chain),
        // TODO: How do?
        proxyAdmin: hyperlaneContractAddresses[chain].proxyAdmin,
      },
    ];
  }),
);
