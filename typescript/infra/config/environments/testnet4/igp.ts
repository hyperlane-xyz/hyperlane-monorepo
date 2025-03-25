import { ChainMap, ChainName, HookType, IgpConfig } from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getOverhead,
} from '../../../src/config/gas-oracle.js';

import { ethereumChainNames } from './chains.js';
import gasPrices from './gasPrices.json';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

function getOracleConfigWithOverrides(origin: ChainName) {
  const oracleConfig = storageGasOracleConfig[origin];
  if (origin === 'infinityvmmonza') {
    // For InfinityVM Monza, override all remote chain gas configs to use 0 gas
    for (const remoteConfig of Object.values(oracleConfig)) {
      remoteConfig.gasPrice = '0';
    }
  }
  // Solana Testnet -> InfinityVM Monza, similarly don't charge gas
  if (origin === 'solanatestnet') {
    oracleConfig['infinityvmmonza'].gasPrice = '0';
  }
  return oracleConfig;
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    tokenPrices,
    gasPrices,
    (local, remote) => getOverhead(local, remote, ethereumChainNames),
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
        exclude(chain, supportedChainNames).map((remote) => [
          remote,
          getOverhead(chain, remote, ethereumChainNames),
        ]),
      ),
    };
  },
);
