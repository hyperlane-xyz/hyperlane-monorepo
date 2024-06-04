import { Provider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { ChainMap, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

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
    case ProtocolType.Cosmos: {
      const { amount } = await getCosmosChainGasPrice(chain);

      return {
        amount,
        decimals: 1,
      };
    }
    case ProtocolType.Sealevel:
      // TODO get a reasonable value
      return {
        amount: '0.001',
        decimals: 9,
      };
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
