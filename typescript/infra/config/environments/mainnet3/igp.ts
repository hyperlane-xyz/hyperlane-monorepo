import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  HookType,
  IgpConfig,
  TOKEN_EXCHANGE_RATE_DECIMALS,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getTokenExchangeRateFromValues,
} from '../../../src/config/gas-oracle.js';

import { ethereumChainNames } from './chains.js';
import gasPrices from './gasPrices.json';
import { DEPLOYER, ethereumChainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

const FOREIGN_DEFAULT_OVERHEAD = 600_000; // cosmwasm warp route somewhat arbitrarily chosen

const remoteOverhead = (remote: ChainName) =>
  ethereumChainNames.includes(remote as any)
    ? multisigIsmVerificationCost(
        defaultMultisigConfigs[remote].threshold,
        defaultMultisigConfigs[remote].validators.length,
      )
    : FOREIGN_DEFAULT_OVERHEAD; // non-ethereum overhead

// Gets the exchange rate of the remote quoted in local tokens
function getTokenExchangeRate(local: ChainName, remote: ChainName): BigNumber {
  const localValue = ethers.utils.parseUnits(
    tokenPrices[local],
    TOKEN_EXCHANGE_RATE_DECIMALS,
  );
  const remoteValue = ethers.utils.parseUnits(
    tokenPrices[remote],
    TOKEN_EXCHANGE_RATE_DECIMALS,
  );

  return getTokenExchangeRateFromValues(local, localValue, remote, remoteValue);
}

const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    gasPrices,
    getTokenExchangeRate,
    (local) => parseFloat(tokenPrices[local]),
    (local) => remoteOverhead(local),
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
        remoteOverhead(remote),
      ]),
    ),
    oracleConfig: storageGasOracleConfig[local],
  }),
);
