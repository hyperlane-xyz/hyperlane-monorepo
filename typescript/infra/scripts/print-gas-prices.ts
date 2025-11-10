import { Provider } from '@ethersproject/providers';
import { ethers } from 'ethers';
import path from 'path';

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
import mainnet3GasPrices from '../config/environments/mainnet3/gasPrices.json' with { type: 'json' };
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';
import testnet4GasPrices from '../config/environments/testnet4/gasPrices.json' with { type: 'json' };
import { supportedChainNames as testnet4SupportedChainNames } from '../config/environments/testnet4/supportedChainNames.js';
import { DeployEnvironment } from '../src/config/environment.js';
import {
  getSafeNumericValue,
  updatePriceIfNeeded,
} from '../src/config/gas-oracle.js';
import { getInfraPath, writeJsonWithAppendMode } from '../src/utils/utils.js';

import { getArgs, withAppend, withWrite } from './agent-utils.js';

const gasPricesFilePath = (environment: DeployEnvironment) => {
  return path.join(
    getInfraPath(),
    `config/environments/${environment}/gasPrices.json`,
  );
};

// Helper function to extract numeric amount from GasPriceConfig
const getGasPriceAmount = (gasPrice: GasPriceConfig | undefined): number => {
  return getSafeNumericValue(gasPrice?.amount, '0');
};

// Helper function to create default gas price config
const createDefaultGasPrice = (
  chain: string,
  decimals: number = 9,
): GasPriceConfig => ({
  amount: `PLEASE SET A GAS PRICE FOR ${chain.toUpperCase()}`,
  decimals,
});

async function main() {
  const { environment, write, append } = await withAppend(withWrite(getArgs()))
    .argv;
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
          const currentGasPrice = gasPrices[
            chain as keyof typeof gasPrices
          ] as GasPriceConfig;
          const newGasPrice = await getGasPrice(mpp, chain, currentGasPrice);

          const currentAmount = getGasPriceAmount(currentGasPrice);
          const newAmount = getGasPriceAmount(newGasPrice);

          const finalGasPrice = updatePriceIfNeeded(
            newGasPrice,
            currentGasPrice,
            newAmount,
            currentAmount,
          );

          return [chain, finalGasPrice];
        } catch (error) {
          console.error(`Error getting gas price for ${chain}:`, error);
          return [
            chain,
            gasPrices[chain as keyof typeof gasPrices] ||
              createDefaultGasPrice(chain),
          ];
        }
      }),
    ),
  );

  if (write || append) {
    const outFile = gasPricesFilePath(environment);
    await writeJsonWithAppendMode(outFile, prices, append);
  } else {
    console.log(JSON.stringify(prices, null, 2));
  }

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
        return currentGasPrice || createDefaultGasPrice(chain, 1);
      }
    }
    case ProtocolType.Radix:
    case ProtocolType.Sealevel:
    case ProtocolType.Starknet:
      // Return the gas price from the config if it exists, otherwise return some default
      // TODO get a reasonable value
      return currentGasPrice || createDefaultGasPrice(chain);
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
