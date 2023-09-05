import { BigNumber, ethers } from 'ethers';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
} from '../../../src/config';
import { TOKEN_EXCHANGE_RATE_DECIMALS } from '../../../src/config/gas-oracle';

import { TestnetChains, chainNames } from './chains';

// Overcharge by 30% to account for market making risk
const TOKEN_EXCHANGE_RATE_MULTIPLIER = ethers.utils.parseUnits(
  '1.30',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);

// Taken by looking at each testnet and overestimating gas prices
const gasPrices: ChainMap<BigNumber> = {
  alfajores: ethers.utils.parseUnits('10', 'gwei'),
  fuji: ethers.utils.parseUnits('30', 'gwei'),
  mumbai: ethers.utils.parseUnits('45', 'gwei'),
  bsctestnet: ethers.utils.parseUnits('15', 'gwei'),
  goerli: ethers.utils.parseUnits('5', 'gwei'),
  sepolia: ethers.utils.parseUnits('5', 'gwei'),
  moonbasealpha: ethers.utils.parseUnits('5', 'gwei'),
  optimismgoerli: ethers.utils.parseUnits('0.5', 'gwei'),
  arbitrumgoerli: ethers.utils.parseUnits('0.5', 'gwei'),
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
  mumbai: Rarity.Rare,
  bsctestnet: Rarity.Rare,
  goerli: Rarity.Mythic,
  sepolia: Rarity.Mythic,
  moonbasealpha: Rarity.Common,
  optimismgoerli: Rarity.Mythic,
  arbitrumgoerli: Rarity.Mythic,
};

// Gets the "value" of a testnet chain
function getApproximateValue(chain: TestnetChains): BigNumber {
  const rarity = chainTokenRarity[chain];
  return RARITY_APPROXIMATE_VALUE[rarity];
}

// Gets the exchange rate of the remote quoted in local tokens
function getTokenExchangeRate(local: ChainName, remote: ChainName): BigNumber {
  const localValue = getApproximateValue(local);
  const remoteValue = getApproximateValue(remote);

  // Apply multiplier to overcharge
  return remoteValue.mul(TOKEN_EXCHANGE_RATE_MULTIPLIER).div(localValue);
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(chainNames, gasPrices, getTokenExchangeRate);
