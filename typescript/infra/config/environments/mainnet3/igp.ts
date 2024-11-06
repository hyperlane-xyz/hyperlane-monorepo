import {
  ChainMap,
  ChainName,
  HookType,
  IgpConfig,
  getTokenExchangeRateFromValues,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  EXCHANGE_RATE_MARGIN_PCT,
  getAllStorageGasOracleConfigs,
  getOverhead,
} from '../../../src/config/gas-oracle.js';
import { mustGetChainNativeToken } from '../../../src/utils/utils.js';

import { ethereumChainNames } from './chains.js';
import gasPrices from './gasPrices.json';
import { DEPLOYER, ethereumChainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

export function getOverheadWithOverrides(local: ChainName, remote: ChainName) {
  let overhead = getOverhead(local, remote, ethereumChainNames);
  if (remote === 'moonbeam') {
    overhead *= 4;
  }
  return overhead;
}

const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    gasPrices,
    (local, remote) =>
      getTokenExchangeRateFromValues({
        local,
        remote,
        tokenPrices,
        exchangeRateMarginPct: EXCHANGE_RATE_MARGIN_PCT,
        decimals: {
          local: mustGetChainNativeToken(local).decimals,
          remote: mustGetChainNativeToken(remote).decimals,
        },
      }),
    (local) => parseFloat(tokenPrices[local]),
    (local, remote) => getOverheadWithOverrides(local, remote),
  );

export const igp: ChainMap<IgpConfig> = objMap(
  ethereumChainOwners,
  (local, owner): IgpConfig => ({
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...owner,
    ownerOverrides: {
      ...owner.ownerOverrides,
      interchainGasPaymaster: DEPLOYER,
      storageGasOracle: DEPLOYER,
    },
    oracleKey: DEPLOYER,
    beneficiary: DEPLOYER,
    overhead: Object.fromEntries(
      exclude(local, supportedChainNames).map((remote) => [
        remote,
        getOverheadWithOverrides(local, remote),
      ]),
    ),
    oracleConfig: storageGasOracleConfig[local],
  }),
);
