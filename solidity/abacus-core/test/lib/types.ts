import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BytesLike, ethers } from 'ethers';

/********* HRE *********/

export interface HardhatAbacusHelpers {
  deployment: any;
  formatMessage: Function;
  governance: {
    formatTransferGovernor: Function;
    formatSetRouter: Function;
    formatCalls: Function;
  };
  messageHash: Function;
  ethersAddressToBytes32: Function;
  destinationAndNonce: Function;
  domainHash: Function;
}

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: HardhatAbacusHelpers;
  }
}

/********* BASIC TYPES *********/
export type Domain = number;
export type Address = string;
export type AddressBytes32 = string;
export type HexString = string;
export type Signer = SignerWithAddress;
export type BytesArray = [
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
  BytesLike,
];

/********* OPTICS CORE *********/
export type Checkpoint = {
  root: string;
  index: number;
  signature: string;
};

export type CallData = {
  to: Address;
  data: string;
};
