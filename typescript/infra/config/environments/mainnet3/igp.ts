import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
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

import {
  MainnetChains,
  ethereumChainNames,
  supportedChainNames,
} from './chains.js';
import gasPrices from './gasPrices.json';
import { DEPLOYER, owners } from './owners.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

const FOREIGN_DEFAULT_OVERHEAD = 600_000; // cosmwasm warp route somewhat arbitrarily chosen

const remoteOverhead = (remote: MainnetChains) =>
  ethereumChainNames.includes(remote)
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
    (local) => remoteOverhead(local as MainnetChains),
  );

export const igp: ChainMap<IgpConfig> = objMap(owners, (local, owner) => ({
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
      remoteOverhead(remote as MainnetChains),
    ]),
  ),
  oracleConfig: storageGasOracleConfig[local],
}));
