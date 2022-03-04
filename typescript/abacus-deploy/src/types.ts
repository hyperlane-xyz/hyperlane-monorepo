import { ethers } from 'ethers';

export type ChainConfig = {
  name: string;
  domain: number;
  signer: ethers.Signer;
  overrides: ethers.Overrides;
  supports1559?: boolean;
  confirmations?: number;
};

export type Address = string;
export type Domain = number;

export type ProxiedAddress = {
  proxy: Address;
  implementation: Address;
  beacon: Address;
};
