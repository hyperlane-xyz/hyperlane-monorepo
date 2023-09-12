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
        exclude(chain, ethereumChainNames)
          .filter((remote) => {
            const remoteConfig = defaultMultisigIsmConfigs[remote];
            if (!remoteConfig) {
              console.warn(
                `WARNING: No default multisig config for ${remote}. Skipping overhead calculation.`,
              );
              return false;
            }
            return true;
          })
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
