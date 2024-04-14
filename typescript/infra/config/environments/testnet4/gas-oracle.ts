import { BigNumber, ethers } from 'ethers';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import {
  AllStorageGasOracleConfigs,
  TOKEN_EXCHANGE_RATE_DECIMALS,
  getAllStorageGasOracleConfigs,
  getTokenExchangeRateFromValues,
} from '../../../src/config/gas-oracle.js';

import { supportedChainNames } from './chains.js';

// Taken by looking at each testnet and overestimating gas prices
const gasPrices: ChainMap<BigNumber> = {
  alfajores: ethers.utils.parseUnits('10', 'gwei'),
  fuji: ethers.utils.parseUnits('30', 'gwei'),
  bsctestnet: ethers.utils.parseUnits('15', 'gwei'),
  sepolia: ethers.utils.parseUnits('5', 'gwei'),
  scrollsepolia: ethers.utils.parseUnits('0.5', 'gwei'),
  chiado: ethers.utils.parseUnits('2', 'gwei'),
  solanatestnet: ethers.BigNumber.from('28'),
  eclipsetestnet: ethers.BigNumber.from('28'),
  plumetestnet: ethers.utils.parseUnits('0.01', 'gwei'),
};

// Used to categorize rarity of testnet tokens & approximate exchange rates.
// Unashamedly borrowed from Fortnite
enum Rarity {
  Common,
  Rare,
  Mythic,
}

// "Value" of the testnet tokens with 10 decimals of precision.
// Imagine these as quoted in USD
const RARITY_APPROXIMATE_VALUE: Record<Rarity, BigNumber> = {
  [Rarity.Common]: ethers.utils.parseUnits('0.5', TOKEN_EXCHANGE_RATE_DECIMALS),
  [Rarity.Rare]: ethers.utils.parseUnits('1', TOKEN_EXCHANGE_RATE_DECIMALS),
  [Rarity.Mythic]: ethers.utils.parseUnits('5', TOKEN_EXCHANGE_RATE_DECIMALS),
};

const chainTokenRarity: ChainMap<Rarity> = {
  alfajores: Rarity.Common,
  fuji: Rarity.Rare,
  bsctestnet: Rarity.Rare,
  sepolia: Rarity.Mythic,
  scrollsepolia: Rarity.Rare,
  chiado: Rarity.Common,
  solanatestnet: Rarity.Common,
  eclipsetestnet: Rarity.Common,
  plumetestnet: Rarity.Common,
};

// Gets the "value" of a testnet chain
function getApproximateValue(chain: ChainName): BigNumber {
  const rarity = chainTokenRarity[chain];
  return RARITY_APPROXIMATE_VALUE[rarity];
}

// Gets the exchange rate of the remote quoted in local tokens
function getTokenExchangeRate(local: ChainName, remote: ChainName): BigNumber {
  const localValue = getApproximateValue(local);
  const remoteValue = getApproximateValue(remote);

  return getTokenExchangeRateFromValues(local, localValue, remote, remoteValue);
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    gasPrices,
    getTokenExchangeRate,
  );
