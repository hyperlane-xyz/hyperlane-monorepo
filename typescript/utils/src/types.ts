import { ethers } from 'ethers';

/********* BASIC TYPES *********/
export type Domain = number;
export type Address = string;
export type AddressBytes32 = string;
export type HexString = string;

/********* ABACUS CORE *********/
export type Checkpoint = {
  root: string;
  index: number; // safe because 2 ** 32 leaves < Number.MAX_VALUE
  signature: ethers.utils.BytesLike;
};

export type CallData = {
  to: Address;
  data: ethers.utils.BytesLike;
};

export enum AbacusState {
  UNINITIALIZED = 0,
  ACTIVE,
  FAILED,
}

export enum MessageStatus {
  NONE = 0,
  PROCESSED,
}

export type ParsedMessage = {
  origin: number;
  sender: string;
  destination: number;
  recipient: string;
  body: string;
};
