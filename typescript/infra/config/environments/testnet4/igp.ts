import {
  ChainMap,
  ChainName,
  HookType,
  IgpConfig,
  StorageGasOracleConfig,
} from '@hyperlane-xyz/sdk';
import { Address, exclude, objFilter, objMap } from '@hyperlane-xyz/utils';

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

const romeTestnetConnectedChains = [
  'sepolia',
  'arbitrumsepolia',
  'basesepolia',
  'optimismsepolia',
  'bsctestnet',
];

export function getOverheadWithOverrides(local: ChainName, remote: ChainName) {
  let overhead = getOverhead(local, remote, ethereumChainNames);

  // Special case for rometestnet due to non-standard gas metering.
  if (remote === 'rometestnet') {
    overhead *= 12;
  }

  return overhead;
}

function getOracleConfigWithOverrides(origin: ChainName) {
  let oracleConfig = storageGasOracleConfig[origin];

  // Special case for rometestnet due to non-standard gas metering.
  if (origin === 'rometestnet') {
    oracleConfig = objFilter(
      storageGasOracleConfig[origin],
      (remoteChain, _): _ is StorageGasOracleConfig =>
        romeTestnetConnectedChains.includes(remoteChain),
    );
  }

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
        exclude(chain, supportedChainNames)
          // Special case for rometestnet due to non-standard gas metering.
          .filter(
            (remote) =>
              chain !== 'rometestnet' ||
              romeTestnetConnectedChains.includes(remote),
          )
          .map((remote) => [remote, getOverheadWithOverrides(chain, remote)]),
      ),
    };
  },
);
