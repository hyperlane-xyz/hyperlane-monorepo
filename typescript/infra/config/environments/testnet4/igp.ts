import {
  ChainMap,
  HookType,
  IgpConfig,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { storageGasOracleConfig } from './gas-oracle.js';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

export const igp: ChainMap<IgpConfig> = objMap(
  owners,
  (chain, ownerConfig): IgpConfig => {
    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
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
  },
);
