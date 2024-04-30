import {
  ChainMap,
  IgpConfig,
  OwnableConfig,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  exclude,
  objFilter,
  objMap,
} from '@hyperlane-xyz/utils';

import { getChain } from '../../registry.js';

import { storageGasOracleConfig } from './gas-oracle.js';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

const evmOwners = objFilter(
  owners,
  (chain, _): _ is OwnableConfig =>
    getChain(chain).protocol === ProtocolType.Ethereum,
);

export const igp: ChainMap<IgpConfig> = objMap(
  evmOwners,
  (chain, ownerConfig) => {
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
  },
);
