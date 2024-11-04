import {
  ChainMap,
  HookType,
  IgpConfig,
  getTokenExchangeRateFromValues,
} from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  EXCHANGE_RATE_MARGIN_PCT,
  getAllStorageGasOracleConfigs,
  getOverhead,
} from '../../../src/config/gas-oracle.js';
import { mustGetChainNativeToken } from '../../../src/utils/utils.js';

import { ethereumChainNames } from './chains.js';
import gasPrices from './gasPrices.json';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
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
  );

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
          getOverhead(chain, remote, ethereumChainNames),
        ]),
      ),
    };
  },
);
