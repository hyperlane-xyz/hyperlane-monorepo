import {
  ChainMap,
  GasOracleContractType,
  IgpConfig,
  hyperlaneContractAddresses,
} from '@hyperlane-xyz/sdk';

import { TestnetChains, chainNames } from './chains';

function getGasOracles(local: TestnetChains) {
  return Object.fromEntries(
    chainNames
      .filter((name) => name !== local)
      .map((name) => [name, GasOracleContractType.StorageGasOracle]),
  );
}

const DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';

export const igp: ChainMap<IgpConfig> = Object.fromEntries(
  chainNames.map((chain) => {
    return [
      chain,
      {
        owner: DEPLOYER_ADDRESS,
        beneficiary: DEPLOYER_ADDRESS,
        gasOracleType: getGasOracles(chain),
        // TODO: How do?
        proxyAdmin: hyperlaneContractAddresses[chain].proxyAdmin,
      },
    ];
  }),
);
