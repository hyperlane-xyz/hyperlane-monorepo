import {
  ChainMap,
  GasOracleContractType,
  OverheadIgpConfig,
  defaultMultisigIsmConfigs,
  multisigIsmVerificationCost,
  objMap,
} from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import { MainnetChains, chainNames } from './chains';
import { owners } from './owners';

const KEY_FUNDER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

function getGasOracles(local: MainnetChains) {
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
      beneficiary: KEY_FUNDER_ADDRESS,
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
