import {
  ChainMap,
  GasOracleContractType,
  IgpConfig,
  hyperlaneContractAddresses,
  objMap,
} from '@hyperlane-xyz/sdk';

import { TestnetChains, chainNames } from './chains';
import { owners } from './owners';

function getGasOracles(local: TestnetChains) {
  return Object.fromEntries(
    chainNames
      .filter((name) => name !== local)
      .map((name) => [name, GasOracleContractType.StorageGasOracle]),
  );
}

export const igp: ChainMap<IgpConfig> = objMap(owners, (chain, owner) => {
  return {
    owner,
    beneficiary: owner,
    gasOracleType: getGasOracles(chain),
    // TODO: How do?
    proxyAdmin: hyperlaneContractAddresses[chain].proxyAdmin,
  };
});
