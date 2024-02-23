import { ethers } from 'ethers';

import { MultiProtocolProvider, ProviderType } from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { getEnvironmentConfig } from './core-utils';

async function main() {
  const environmentConfig = getEnvironmentConfig('mainnet3');
  const metadata = environmentConfig.chainMetadataConfigs;

  const mpp = new MultiProtocolProvider(metadata);

  const prices = await promiseObjAll(
    objMap(metadata, async (chain, _) => {
      const provider = mpp.getProvider(chain);
      switch (provider.type) {
        case ProviderType.EthersV5:
          const gasPrice = await provider.provider.getGasPrice();
          return ethers.utils.formatUnits(gasPrice, 'gwei');
        case ProviderType.CosmJsWasm:
          // TODO: get default gas price
          return '0.1';
        case ProviderType.SolanaWeb3:
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
