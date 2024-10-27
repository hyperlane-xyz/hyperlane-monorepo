import { ChainMap, ChainName, HookType, IgpConfig } from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getOverhead,
  getTokenExchangeRateFromValues,
} from '../../../src/config/gas-oracle.js';

import { ethereumChainNames } from './chains.js';
import gasPrices from './gasPrices.json';
import { DEPLOYER, ethereumChainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

const getOverheadWithOverrides = (local: ChainName, remote: ChainName) => {
  let overhead = getOverhead(local, remote, ethereumChainNames);
  if (remote === 'moonbeam') {
    overhead *= 4;
  }
  return overhead;
};

const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    gasPrices,
    (local, remote) =>
      getTokenExchangeRateFromValues(local, remote, tokenPrices),
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
