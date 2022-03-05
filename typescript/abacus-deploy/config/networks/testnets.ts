import { BigNumber } from 'ethers';
import { ChainWithoutSigner, ChainName } from '../../src/config/chain';

export const alfajores: ChainWithoutSigner = {
  name: ChainName.ALFAJORES,
  domain: 1000,
  confirmations: 1,
  overrides: {},
};

export const fuji: ChainWithoutSigner = {
  name: ChainName.FUJI,
  domain: 43113,
  confirmations: 3,
  overrides: {},
};

export const gorli: ChainWithoutSigner = {
  name: ChainName.GORLI,
  domain: 5,
  confirmations: 3,
  overrides: {
    gasPrice: BigNumber.from(10_000_000_000),
  },
};

export const kovan: ChainWithoutSigner = {
  name: ChainName.KOVAN,
  domain: 3000,
  overrides: {
    gasPrice: BigNumber.from(10_000_000_000),
  },
};

export const mumbai: ChainWithoutSigner = {
  name: ChainName.MUMBAI,
  domain: 80001,
  confirmations: 3,
  overrides: {},
};

export const rinkarby: ChainWithoutSigner = {
  name: ChainName.RINKARBY,
  domain: 4000,
  overrides: {
    gasPrice: 0,
    gasLimit: 600_000_000,
  },
};

export const rinkeby: ChainWithoutSigner = {
  name: ChainName.RINKEBY,
  domain: 2000,
  confirmations: 3,
  overrides: {},
};

export const ropsten: ChainWithoutSigner = {
  name: ChainName.ROPSTEN,
  domain: 3,
  confirmations: 3,
  overrides: {
    gasPrice: BigNumber.from(10_000_000_000),
  },
};
