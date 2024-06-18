import { Provider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { ChainMap, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

// Intentionally circumvent `mainnet3/index.ts` and `getEnvironmentConfig('mainnet3')`
// to avoid circular dependencies.
import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import {
  GasPriceConfig,
  getCosmosChainGasPrice,
} from '../src/config/gas-oracle.js';

async function main() {
  const registry = await getMainnet3Registry();
  const chainMetadata = await registry.getMetadata();
  const mpp = new MultiProtocolProvider(chainMetadata);

  const prices: ChainMap<GasPriceConfig> = Object.fromEntries(
    await Promise.all(
      mainnet3SupportedChainNames.map(async (chain) => [
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
