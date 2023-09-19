import {
  ChainMap,
  GasOracleContractType,
  OverheadIgpConfig,
  defaultMultisigIsmConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  TestnetChains,
  ethereumChainNames,
  supportedChainNames,
} from './chains';
import { owners } from './owners';

function getGasOracles(local: TestnetChains) {
  return Object.fromEntries(
    exclude(local, supportedChainNames).map((name) => [
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
      oracleKey: owner,
      beneficiary: owner,
      gasOracleType: getGasOracles(chain),
      overhead: Object.fromEntries(
        // Not setting overhead for non-Ethereum destination chains
        exclude(chain, ethereumChainNames).map((remote) => [
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
