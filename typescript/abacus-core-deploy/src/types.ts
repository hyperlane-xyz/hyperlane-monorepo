import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';

export type ChainConfig = {
  name: string;
  domain: number;
  signer: ethers.Signer;
  overrides: ethers.Overrides;
  supports1559?: boolean;
  confirmations?: number;
};

export type ProxiedAddress = {
  proxy: types.Address;
  implementation: types.Address;
  beacon: types.Address;
};
