import { Provider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import {
  ChainMap,
  GasPriceConfig,
  MultiProtocolProvider,
  getCosmosChainGasPrice,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

// Intentionally circumvent `mainnet3/index.ts` and `getEnvironmentConfig('mainnet3')`
// to avoid circular dependencies.
import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import mainnet3GasPrices from '../config/environments/mainnet3/gasPrices.json' assert { type: 'json' };
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';
import testnet4GasPrices from '../config/environments/testnet4/gasPrices.json' assert { type: 'json' };
import { supportedChainNames as testnet4SupportedChainNames } from '../config/environments/testnet4/supportedChainNames.js';

import { getArgs } from './agent-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const { registry, supportedChainNames, gasPrices } =
    environment === 'mainnet3'
      ? {
          registry: await getMainnet3Registry(),
          supportedChainNames: mainnet3SupportedChainNames,
          gasPrices: mainnet3GasPrices,
        }
      : {
          registry: await getTestnet4Registry(),
          supportedChainNames: testnet4SupportedChainNames,
          gasPrices: testnet4GasPrices,
        };

  const chainMetadata = await registry.getMetadata();
  const mpp = new MultiProtocolProvider(chainMetadata);

  const prices: ChainMap<GasPriceConfig> = Object.fromEntries(
    await Promise.all(
      supportedChainNames.map(async (chain) => {
        try {
          return [
            chain,
            await getGasPrice(
              mpp,
              chain,
              gasPrices[chain as keyof typeof gasPrices],
            ),
          ];
        } catch (error) {
          console.error(`Error getting gas price for ${chain}:`, error);
          return [
            chain,
            gasPrices[chain as keyof typeof gasPrices] || {
              amount: '0',
              decimals: 9,
            },
          ];
        }
      }),
    ),
  );

  console.log(JSON.stringify(prices, null, 2));
  process.exit(0);
}

async function getGasPrice(
  mpp: MultiProtocolProvider,
  chain: string,
  currentGasPrice?: GasPriceConfig,
): Promise<GasPriceConfig> {
  const protocolType = mpp.getProtocol(chain);
  switch (protocolType) {
    case ProtocolType.Ethereum: {
      const provider = mpp.getProvider(chain);
      const gasPrice = await (provider.provider as Provider).getGasPrice();
      return {
        amount: ethers.utils.formatUnits(gasPrice, 'gwei'),
        decimals: 9,
      };
    }
    case ProtocolType.Cosmos:
    case ProtocolType.CosmosNative: {
      try {
        const { amount } = await getCosmosChainGasPrice(chain, mpp);
        return {
          amount,
          decimals: 1,
        };
      } catch (error) {
        console.error(
          `Error getting gas price for cosmos chain ${chain}:`,
          error,
        );
        if (currentGasPrice) {
          return currentGasPrice;
        } else {
          return {
            amount: 'PLEASE SET A GAS PRICE FOR COSMOS CHAIN',
            decimals: 1,
          };
        }
      }
    }
    case ProtocolType.Sealevel:
      // Return the gas price from the config if it exists, otherwise return some  default
      // TODO get a reasonable value
      return (
        currentGasPrice ?? {
          amount: 'PLEASE SET A GAS PRICE FOR SEALEVEL',
          decimals: 1,
        }
      );
    default:
      throw new Error(`Unsupported protocol type: ${protocolType}`);
  }
}

main()
  .then()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
