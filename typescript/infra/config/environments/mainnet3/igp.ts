// SPDX-License-Identifier: BUSL-1.1
import { ChainMap, ChainName, HookType, IgpConfig } from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getOverheadWithOverrides,
} from '../../../src/config/gas-oracle.js';

import { getEdenIgpConfig } from './eden.js';
import { getTronIgpConfig } from './tron.js';
import gasPrices from './gasPrices.json' with { type: 'json' };
import { DEPLOYER, chainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json' with { type: 'json' };

const tokenPrices: ChainMap<string> = rawTokenPrices;

function getOracleConfigWithOverrides(origin: ChainName) {
  const oracleConfig = storageGasOracleConfig[origin];

  // WORKAROUND for Sealevel IGP decimal bug (solaxy-specific):
  // The Rust Sealevel IGP code hardcodes SOL_DECIMALS = 9, but solaxy has 6 decimals.
  // Rather than trying to calculate the correct workaround values, we hardcode
  // the values that are already set on-chain and known to work.
  if (origin === 'solaxy') {
    oracleConfig.ethereum = {
      gasPrice: '9',
      tokenExchangeRate: '15000000000000000000',
      tokenDecimals: 6,
    };
    oracleConfig.solanamainnet = {
      gasPrice: '1',
      tokenExchangeRate: '15000000000000000000',
      tokenDecimals: 6,
    };
  }

  return oracleConfig;
}

const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    tokenPrices,
    gasPrices,
    (local, remote) => getOverheadWithOverrides(local, remote),
    true,
  );

export const igp: ChainMap<IgpConfig> = objMap(
  chainOwners,
  (local, owner): IgpConfig => {
    if (local === 'eden') {
      return getEdenIgpConfig(owner, storageGasOracleConfig);
    }

    if (local === 'tron') {
      return getTronIgpConfig(owner, storageGasOracleConfig);
    }

    return {
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
      oracleConfig: getOracleConfigWithOverrides(local),
    };
  },
);
