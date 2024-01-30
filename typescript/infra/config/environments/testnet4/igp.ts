import {
  ChainMap,
  ChainName,
  GasOracleContractType,
  IgpConfig,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import { supportedChainNames } from './chains';
import { owners } from './owners';

function getGasOracles(local: ChainName) {
  return Object.fromEntries(
    exclude(local, supportedChainNames).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

export const igp: ChainMap<IgpConfig> = objMap(owners, (chain, ownerConfig) => {
  return {
    ...ownerConfig,
    oracleKey: ownerConfig.owner,
    beneficiary: ownerConfig.owner,
    gasOracleType: getGasOracles(chain),
    overhead: Object.fromEntries(
      exclude(chain, supportedChainNames).map((remote) => [
        remote,
        multisigIsmVerificationCost(
          // TODO: parameterize this
          defaultMultisigConfigs[remote].threshold,
          defaultMultisigConfigs[remote].validators.length,
        ),
      ]),
    ),
  };
});
