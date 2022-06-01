/********* BASIC TYPES *********/
export type Domain = number;
export type Address = string;
export type AddressBytes32 = string;
export type HexString = string;

/********* ABACUS CORE *********/
export type Checkpoint = {
  root: string;
  index: number;
  signature: string;
};

export type CallData = {
  to: Address;
  data: string;
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
