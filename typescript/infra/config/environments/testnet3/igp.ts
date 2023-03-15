import {
  ChainMap,
  GasOracleContractType,
  OverheadIgpConfig,
  multisigIsmVerificationCost,
  objMap,
} from '@hyperlane-xyz/sdk';

import { TestnetChains, chainNames } from './chains';
import { multisigIsm } from './multisigIsm';
import { owners } from './owners';

function remotes(local: TestnetChains) {
  return chainNames.filter((name) => name !== local);
}

function getGasOracles(local: TestnetChains) {
  return Object.fromEntries(
    remotes(local).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

export const igp: ChainMap<OverheadIgpConfig> = objMap(
  owners,
  (chain, owner) => {
    return {
      owner,
      beneficiary: owner,
      gasOracleType: getGasOracles(chain),
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
