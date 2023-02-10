import { BigNumber, ethers } from 'ethers';

import { ChainMap, Remotes } from '@hyperlane-xyz/sdk';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
} from '../../../src/config';
import {
  TOKEN_EXCHANGE_RATE_DECIMALS,
  TOKEN_EXCHANGE_RATE_SCALE,
} from '../../../src/config/gas-oracle';

import { TestnetChains, chainNames } from './chains';

// Taken by looking at each testnet and overestimating gas prices
const testnetGasPrices: ChainMap<TestnetChains, BigNumber> = {
  alfajores: ethers.utils.parseUnits('10', 'gwei'),
  fuji: ethers.utils.parseUnits('30', 'gwei'),
  mumbai: ethers.utils.parseUnits('45', 'gwei'),
  bsctestnet: ethers.utils.parseUnits('15', 'gwei'),
  goerli: ethers.utils.parseUnits('5', 'gwei'),
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
const rarityApproximateValue: Record<Rarity, BigNumber> = {
  [Rarity.Common]: ethers.utils.parseUnits('0.5', TOKEN_EXCHANGE_RATE_DECIMALS),
  [Rarity.Rare]: ethers.utils.parseUnits('1', TOKEN_EXCHANGE_RATE_DECIMALS),
  [Rarity.Mythic]: ethers.utils.parseUnits('5', TOKEN_EXCHANGE_RATE_DECIMALS),
};

const chainTokenRarity: ChainMap<TestnetChains, Rarity> = {
  alfajores: Rarity.Common,
  fuji: Rarity.Rare,
  mumbai: Rarity.Rare,
  bsctestnet: Rarity.Rare,
  goerli: Rarity.Mythic,
  moonbasealpha: Rarity.Common,
  optimismgoerli: Rarity.Mythic,
  arbitrumgoerli: Rarity.Mythic,
};

// Gets the "value" of a testnet chain
function getApproximateValue(chain: TestnetChains): BigNumber {
  const rarity = chainTokenRarity[chain];
  return rarityApproximateValue[rarity];
}

// Gets the exchange rate of the remote quoted in local tokens
function getTestnetTokenExchangeRate<LocalChain extends TestnetChains>(
  local: LocalChain,
  remote: Remotes<TestnetChains, LocalChain>,
): BigNumber {
  const localValue = getApproximateValue(local);
  const remoteValue = getApproximateValue(remote);

  return remoteValue.mul(TOKEN_EXCHANGE_RATE_SCALE).div(localValue);
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs<TestnetChains> =
  getAllStorageGasOracleConfigs(
    chainNames,
    testnetGasPrices,
    getTestnetTokenExchangeRate,
  );
