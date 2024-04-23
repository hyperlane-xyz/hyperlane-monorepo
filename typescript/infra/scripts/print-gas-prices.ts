import { ethers } from 'ethers';

import { MultiProtocolProvider, ProviderType } from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { mainnetConfigs } from '../config/environments/mainnet3/chains.js';
import { getCosmosChainGasPrice } from '../src/config/gas-oracle.js';

async function main() {
  const allMetadatas = mainnetConfigs;

  const mpp = new MultiProtocolProvider(allMetadatas);

  const prices = await promiseObjAll(
    objMap(allMetadatas, async (chain, metadata) => {
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
          return '0.001';
        default:
          throw new Error(`Unsupported provider type: ${provider.type}`);
      }
    }),
  );

  console.log(JSON.stringify(prices, null, 2));
}

main()
  .then()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
