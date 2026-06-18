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
import { tokenGasOracleConfigs } from './tokenGasOracles.js';
import rawTokenPrices from './tokenPrices.json' with { type: 'json' };

const tokenPrices: ChainMap<string> = rawTokenPrices;

export function getOverheadWithOverrides(local: ChainName, remote: ChainName) {
  let overhead = getOverhead(local, remote);

  if (remote === 'somniatestnet') {
    overhead *= 2;
  }

  return overhead;
}

function getOracleConfigWithOverrides(origin: ChainName) {
  let oracleConfig = getStorageGasOracleConfig()[origin];
  return oracleConfig;
}

// Lazily computes the full storage gas oracle config matrix (every local x
// remote chain pair). This is expensive and emits precision-rebalance warnings,
// so it is deferred until first use rather than run at module import time —
// otherwise any script that merely imports the environment config pays for it.
// Memoized so repeated access is cheap.
let storageGasOracleConfigCache: AllStorageGasOracleConfigs | undefined;
function getStorageGasOracleConfig(): AllStorageGasOracleConfigs {
  if (!storageGasOracleConfigCache) {
    storageGasOracleConfigCache = getAllStorageGasOracleConfigs(
      supportedChainNames,
      tokenPrices,
      gasPrices,
      (local, remote) => getOverheadWithOverrides(local, remote),
      false,
    );
  }
  return storageGasOracleConfigCache;
}

// Lazily builds the IGP config map. Deferred (and memoized) for the same reason
// as the gas oracle config above.
let igpCache: ChainMap<IgpConfig> | undefined;
export function getIgp(): ChainMap<IgpConfig> {
  if (igpCache) {
    return igpCache;
  }
  igpCache = objMap(owners, (chain, ownerConfig): IgpConfig => {
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
      // Per-fee-token gas oracles for token-denominated IGP fees; configured in
      // tokenGasOracles.ts (empty by default).
      ...(tokenGasOracleConfigs[chain]
        ? { tokenOracleConfig: tokenGasOracleConfigs[chain] }
        : {}),
    };
  });
  return igpCache;
}
