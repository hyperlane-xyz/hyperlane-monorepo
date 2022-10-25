import { BigNumber, ethers } from 'ethers';

/********* BASIC TYPES *********/
export type Domain = number;
export type Address = string;
export type AddressBytes32 = string;
export type HexString = string;

// copied from node_modules/@ethersproject/bytes/src.ts/index.ts
export type SignatureLike =
  | {
      r: string;
      s?: string;
      _vs?: string;
      recoveryParam?: number;
      v?: number;
    }
  | ethers.utils.BytesLike;

export type MerkleProof = {
  branch: ethers.utils.BytesLike[];
  leaf: ethers.utils.BytesLike;
  index: number;
};

/********* HYPERLANE CORE *********/
export type Checkpoint = {
  root: string;
  index: number; // safe because 2 ** 32 leaves < Number.MAX_VALUE
  signature: SignatureLike;
};

export type CallData = {
  to: Address;
  data: string;
};

export type ParsedMessage = {
  version: number;
  nonce: BigNumber;
  origin: number;
  sender: string;
  destination: number;
  recipient: string;
  body: string;
};
