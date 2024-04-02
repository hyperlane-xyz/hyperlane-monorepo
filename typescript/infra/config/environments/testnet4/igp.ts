import {
  ChainMap,
  IgpConfig,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { supportedChainNames } from './chains';
import { storageGasOracleConfig } from './gas-oracle';
import { owners } from './owners';

export const igp: ChainMap<IgpConfig> = objMap(owners, (chain, ownerConfig) => {
  return {
    ...ownerConfig,
    oracleKey: ownerConfig.owner as Address,
    beneficiary: ownerConfig.owner as Address,
    oracleConfig: storageGasOracleConfig[chain],
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
