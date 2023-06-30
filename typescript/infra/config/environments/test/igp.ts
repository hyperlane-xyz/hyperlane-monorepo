import {
  ChainMap,
  GasOracleContractType,
  OverheadIgpConfig,
  multisigIsmVerificationCost,
  objMap,
} from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import { TestChains, chainNames } from './chains';
import { multisigIsm } from './multisigIsm';
import { owners } from './owners';

function getGasOracles(local: TestChains) {
  return Object.fromEntries(
    utils
      .exclude(local, chainNames)
      .map((name) => [name, GasOracleContractType.StorageGasOracle]),
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
        utils
          .exclude(chain, chainNames)
          .map((remote) => [
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
