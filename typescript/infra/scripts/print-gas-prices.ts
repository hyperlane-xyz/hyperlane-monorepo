import { ethers } from 'ethers';

import {
  ChainMap,
  MultiProtocolProvider,
  ProviderType,
} from '@hyperlane-xyz/sdk';

import {
  GasPriceConfig,
  getCosmosChainGasPrice,
} from '../src/config/gas-oracle.js';

import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const environmentConfig = getEnvironmentConfig('mainnet3');

  const mpp = await environmentConfig.getMultiProtocolProvider();

  const prices: ChainMap<GasPriceConfig> = Object.fromEntries(
    await Promise.all(
      environmentConfig.supportedChainNames.map(async (chain) => [
        chain,
        await getGasPrice(mpp, chain),
      ]),
    ),
  );

  console.log(JSON.stringify(prices, null, 2));
}

async function getGasPrice(
  mpp: MultiProtocolProvider,
  chain: string,
): Promise<GasPriceConfig> {
  const provider = mpp.getProvider(chain);
  switch (provider.type) {
    case ProviderType.EthersV5: {
      const gasPrice = await provider.provider.getGasPrice();
      return {
        amount: ethers.utils.formatUnits(gasPrice, 'gwei'),
        decimals: 9,
      };
    }
    case ProviderType.CosmJsWasm: {
      const { amount } = await getCosmosChainGasPrice(chain);

      return {
        amount,
        decimals: 1,
      };
    }
    case ProviderType.SolanaWeb3:
      // TODO get a reasonable value
      return {
        amount: '0.001',
        decimals: 9,
      };
    default:
      throw new Error(`Unsupported provider type: ${provider.type}`);
  }
}

main()
  .then()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
