import {
  ChainMap,
  ChainName,
  HookType,
  IgpConfig,
  IgpVersion,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getOverheadWithOverrides,
} from '../../../src/config/gas-oracle.js';
import { legacyIgpChains } from '../../../src/config/chain.js';

import { getEdenIgpConfig } from './eden.js';
import { getTronIgpConfig } from './tron.js';
import gasPrices from './gasPrices.json' with { type: 'json' };
import { DEPLOYER, chainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import { tokenGasOracleConfigs } from './tokenGasOracles.js';
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
    const tokenOracleConfig = tokenGasOracleConfigs[local];
    if (local === 'eden') {
      return {
        ...getEdenIgpConfig(owner, storageGasOracleConfig),
        ...(tokenOracleConfig ? { tokenOracleConfig } : {}),
      };
    }

    if (local === 'tron') {
      return {
        ...getTronIgpConfig(owner, storageGasOracleConfig),
        ...(tokenOracleConfig ? { tokenOracleConfig } : {}),
      };
    }

    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      ...(legacyIgpChains.includes(local)
        ? { igpVersion: IgpVersion.Legacy }
        : {}),
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
      // Per-fee-token gas oracles for token-denominated IGP fees; configured in
      // tokenGasOracles.ts (empty by default).
      ...(tokenOracleConfig ? { tokenOracleConfig } : {}),
    };
  },
);
