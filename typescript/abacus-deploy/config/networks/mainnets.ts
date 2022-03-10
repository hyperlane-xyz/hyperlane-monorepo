import { BigNumber } from 'ethers';
import { ChainConfigWithoutSigner, ChainName } from '../../src/config/chain';

export const celo: ChainConfigWithoutSigner = {
  name: ChainName.CELO,
  domain: 0x63656c6f, // b'celo' interpreted as an int
  overrides: {},
};

export const ethereum: ChainConfigWithoutSigner = {
  name: ChainName.ETHEREUM,
  domain: 0x657468, // b'eth' interpreted as an int
  overrides: {
    // This isn't actually used because Ethereum supports EIP 1559 - but just in case
    gasPrice: '400000000000', // 400 gwei
    // EIP 1559 params
    maxFeePerGas: '300000000000', // 300 gwei
    maxPriorityFeePerGas: '4000000000', // 4 gwei
  },
};

export const avalanche: ChainConfigWithoutSigner = {
  name: ChainName.AVALANCHE,
  domain: 0x61766178, // b'avax' interpreted as an int
  overrides: {
    // This isn't actually used because Avalanche supports EIP 1559 - but just in case
    gasPrice: BigNumber.from(50_000_000_000), // 50 nAVAX (50 gwei)
    // EIP 1559 params
    maxFeePerGas: '50000000000', // 50 nAVAX (50 gwei)
    maxPriorityFeePerGas: '10000000000', // 10 nAVAX (10 gwei)
  },
};

export const polygon: ChainConfigWithoutSigner = {
  name: ChainName.POLYGON,
  domain: 0x706f6c79, // b'poly' interpreted as an int
  overrides: {
    gasPrice: '5000000000', // 50 gwei
  },
};
