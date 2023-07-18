import {
  ChainMap,
  GasOracleContractType,
  OverheadIgpConfig,
  defaultMultisigIsmConfigs,
  multisigIsmVerificationCost,
  objMap,
} from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import { TestnetChains, chainNames } from './chains';
import { owners } from './owners';

function getGasOracles(local: TestnetChains) {
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
              defaultMultisigIsmConfigs[remote].threshold,
              defaultMultisigIsmConfigs[remote].validators.length,
            ),
          ]),
      ),
    };
  },
);
