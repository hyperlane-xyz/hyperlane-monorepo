import {
  ChainMap,
  ChainName,
  HookType,
  IgpConfig,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { isEthereumProtocolChain } from '../../../src/utils/utils.js';

import { storageGasOracleConfig } from './gas-oracle.js';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

const FOREIGN_DEFAULT_OVERHEAD = 600_000; // cosmwasm warp route somewhat arbitrarily chosen
const remoteOverhead = (remote: ChainName) =>
  supportedChainNames.filter(isEthereumProtocolChain).includes(remote as any)
    ? multisigIsmVerificationCost(
        defaultMultisigConfigs[remote].threshold,
        defaultMultisigConfigs[remote].validators.length,
      )
    : FOREIGN_DEFAULT_OVERHEAD; // non-ethereum overhead

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
          remoteOverhead(remote),
        ]),
      ),
    };
  },
);
