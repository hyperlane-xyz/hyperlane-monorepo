import {
  ChainMap,
  GasOracleContractType,
  IgpConfig,
  defaultMultisigIsmConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import { TestnetChains, supportedChainNames } from './chains';
import { owners } from './owners';

function getGasOracles(local: TestnetChains) {
  return Object.fromEntries(
    exclude(local, supportedChainNames).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

export const igp: ChainMap<IgpConfig> = objMap(owners, (chain, owner) => {
  return {
    owner,
    oracleKey: owner,
    beneficiary: owner,
    gasOracleType: getGasOracles(chain),
    overhead: Object.fromEntries(
      exclude(chain, supportedChainNames).map((remote) => [
        remote,
        multisigIsmVerificationCost(
          defaultMultisigIsmConfigs[remote].threshold,
          defaultMultisigIsmConfigs[remote].validators.length,
        ),
      ]),
    ),
  };
});
