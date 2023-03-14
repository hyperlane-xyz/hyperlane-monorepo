import {
  ChainMap,
  GasOracleContractType,
  IgpConfig,
  hyperlaneContractAddresses,
  objMap,
} from '@hyperlane-xyz/sdk';

import { MainnetChains, chainNames } from './chains';
import { owners } from './owners';

function getGasOracles(local: MainnetChains) {
  return Object.fromEntries(
    chainNames
      .filter((name) => name !== local)
      .map((name) => [name, GasOracleContractType.StorageGasOracle]),
  );
}

const KEY_FUNDER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

export const igp: ChainMap<IgpConfig> = objMap(owners, (chain, owner) => {
  return {
    owner,
    beneficiary: KEY_FUNDER_ADDRESS,
    gasOracleType: getGasOracles(chain),
    // TODO: How do?
    proxyAdmin: hyperlaneContractAddresses[chain].proxyAdmin,
  };
});
