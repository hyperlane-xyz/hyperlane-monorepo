import {
  ChainMap,
  GasOracleContractType,
  OverheadIgpConfig,
  hyperlaneContractAddresses,
  multisigIsmVerificationCost,
  objMap,
} from '@hyperlane-xyz/sdk';

import { MainnetChains, chainNames } from './chains';
import { multisigIsm } from './multisigIsm';
import { owners } from './owners';

function remotes(local: MainnetChains) {
  return chainNames.filter((name) => name !== local);
}

function getGasOracles(local: MainnetChains) {
  return Object.fromEntries(
    remotes(local).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

const KEY_FUNDER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

export const igp: ChainMap<OverheadIgpConfig> = objMap(
  owners,
  (chain, owner) => {
    return {
      owner,
      beneficiary: KEY_FUNDER_ADDRESS,
      gasOracleType: getGasOracles(chain),
      // TODO: How do?
      proxyAdmin: hyperlaneContractAddresses[chain].proxyAdmin,
      overhead: Object.fromEntries(
        remotes(chain).map((remote) => [
          remote,
          multisigIsmVerificationCost(
            multisigIsm[remote].threshold,
            multisigIsm[remote].validators.length,
          ),
        ]),
      ),
    };
  },
);
