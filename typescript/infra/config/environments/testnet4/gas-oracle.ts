import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  TOKEN_EXCHANGE_RATE_DECIMALS,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getTokenExchangeRateFromValues,
} from '../../../src/config/gas-oracle.js';

import { ethereumChainNames } from './chains.js';
import { testnet4SupportedChainNames } from './supportedChainNames.js';

// Taken by looking at each testnet and overestimating gas prices
const gasPrices: Record<
  (typeof testnet4SupportedChainNames)[number],
  BigNumber
> = {
  alfajores: ethers.utils.parseUnits('10', 'gwei'),
  bsctestnet: ethers.utils.parseUnits('15', 'gwei'),
  connextsepolia: ethers.utils.parseUnits('0.5', 'gwei'),
  eclipsetestnet: ethers.BigNumber.from('28'),
  fuji: ethers.utils.parseUnits('30', 'gwei'),
  holesky: ethers.utils.parseUnits('10', 'gwei'),
  plumetestnet: ethers.utils.parseUnits('0.01', 'gwei'),
  scrollsepolia: ethers.utils.parseUnits('0.5', 'gwei'),
  sepolia: ethers.utils.parseUnits('5', 'gwei'),
  solanatestnet: ethers.BigNumber.from('28'),
  superpositiontestnet: ethers.utils.parseUnits('0.5', 'gwei'),
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

const chainTokenRarity: Record<
  (typeof testnet4SupportedChainNames)[number],
  Rarity
> = {
  alfajores: Rarity.Common,
  bsctestnet: Rarity.Rare,
  connextsepolia: Rarity.Common,
  eclipsetestnet: Rarity.Common,
  fuji: Rarity.Rare,
  holesky: Rarity.Common,
  plumetestnet: Rarity.Common,
  scrollsepolia: Rarity.Rare,
  sepolia: Rarity.Mythic,
  solanatestnet: Rarity.Common,
  superpositiontestnet: Rarity.Common,
};

// Gets the "value" of a testnet chain
function getApproximateValue(chain: ChainName): BigNumber {
  const rarity = chainTokenRarity[chain as keyof typeof chainTokenRarity];
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
    ethereumChainNames,
    objMap(gasPrices, (_, gasPrice) => ({
      amount: gasPrice.toString(),
      decimals: 1,
    })),
    getTokenExchangeRate,
  );
