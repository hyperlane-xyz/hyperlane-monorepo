import { ChainMap, ChainName, HookType, IgpConfig } from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getOverhead,
} from '../../../src/config/gas-oracle.js';

import gasPrices from './gasPrices.json' with { type: 'json' };
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json' with { type: 'json' };

const tokenPrices: ChainMap<string> = rawTokenPrices;

export function getOverheadWithOverrides(local: ChainName, remote: ChainName) {
  let overhead = getOverhead(local, remote);
  return overhead;
}

function getOracleConfigWithOverrides(origin: ChainName) {
  let oracleConfig = storageGasOracleConfig[origin];
  return oracleConfig;
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    tokenPrices,
    gasPrices,
    (local, remote) => getOverheadWithOverrides(local, remote),
    false,
  );

export const igp: ChainMap<IgpConfig> = objMap(
  owners,
  (chain, ownerConfig): IgpConfig => {
    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      ...ownerConfig,
      oracleKey: ownerConfig.owner as Address,
      beneficiary: ownerConfig.owner as Address,
      oracleConfig: getOracleConfigWithOverrides(chain),
      overhead: Object.fromEntries(
        // no need to set overhead for chain to itself
        exclude(chain, supportedChainNames).map((remote) => [
          remote,
          getOverheadWithOverrides(chain, remote),
        ]),
      ),
    };
  },
);
