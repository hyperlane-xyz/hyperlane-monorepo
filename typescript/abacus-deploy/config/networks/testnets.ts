import { BigNumber } from 'ethers';
import { ChainConfigWithoutSigner, ChainName } from '../../src/config/chain';

export const alfajores: ChainConfigWithoutSigner = {
  name: ChainName.ALFAJORES,
  domain: 1000,
  confirmations: 1,
  overrides: {},
  reorg_period: 0,
};

export const fuji: ChainConfigWithoutSigner = {
  name: ChainName.FUJI,
  domain: 43113,
  confirmations: 3,
  overrides: {},
  reorg_period: 0,
};

export const goerli: ChainConfigWithoutSigner = {
  name: ChainName.GOERLI,
  domain: 5,
  confirmations: 3,
  overrides: {
    gasPrice: BigNumber.from(10_000_000_000),
  },
  reorg_period: 3,
};

export const kovan: ChainConfigWithoutSigner = {
  name: ChainName.KOVAN,
  domain: 3000,
  overrides: {
    gasPrice: BigNumber.from(10_000_000_000),
  },
  reorg_period: 2,
};

export const mumbai: ChainConfigWithoutSigner = {
  name: ChainName.MUMBAI,
  domain: 80001,
  confirmations: 3,
  overrides: {},
  reorg_period: 2,
};

export const rinkarby: ChainConfigWithoutSigner = {
  name: ChainName.RINKARBY,
  domain: 4000,
  overrides: {
    gasPrice: 0,
    gasLimit: 600_000_000,
  },
  reorg_period: 2,
};

export const rinkeby: ChainConfigWithoutSigner = {
  name: ChainName.RINKEBY,
  domain: 2000,
  confirmations: 3,
  overrides: {},
  reorg_period: 2,
};

export const ropsten: ChainConfigWithoutSigner = {
  name: ChainName.ROPSTEN,
  domain: 3,
  confirmations: 3,
  overrides: {
    gasPrice: BigNumber.from(10_000_000_000),
  },
  reorg_period: 2,
};
