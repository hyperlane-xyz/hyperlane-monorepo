import { ethers } from 'ethers';

import {
  ChainName,
  MultiProtocolProvider,
  ProviderType,
} from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { mainnetConfigs } from '../config/environments/mainnet3/chains';

const metadata = mainnetConfigs;

const getCosmosGasPrice = async (chain: ChainName) => {
  const resp = await fetch(
    `https://raw.githubusercontent.com/cosmos/chain-registry/master/${chain}/chain.json`,
  );
  const data = await resp.json();
  // first fee token is native
  return data.fees.fee_tokens[0].high_gas_price;
};

async function main() {
  const mpp = new MultiProtocolProvider(metadata);

  const prices = await promiseObjAll(
    objMap(metadata, async (chain, _) => {
      const provider = mpp.getProvider(chain);
      switch (provider.type) {
        case ProviderType.EthersV5:
          const ethGasPrice = await provider.provider.getGasPrice();
          return ethGasPrice.toString();
        case ProviderType.CosmJsWasm:
          const gasPrice = await getCosmosGasPrice(chain);
          return gasPrice.toString();
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
