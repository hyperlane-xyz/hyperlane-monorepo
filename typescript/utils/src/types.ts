import type { BigNumber, ethers } from 'ethers';

export enum ProtocolType {
  Ethereum = 'ethereum',
  Sealevel = 'sealevel',
  Fuel = 'fuel',
  Cosmos = 'cosmos',
}
// A type that also allows for literal values of the enum
export type ProtocolTypeValue = `${ProtocolType}`;

export const ProtocolSmallestUnit = {
  [ProtocolType.Ethereum]: 'wei',
  [ProtocolType.Sealevel]: 'lamports',
  [ProtocolType.Cosmos]: 'uATOM',
};

/********* BASIC TYPES *********/
export type Domain = number;
export type ChainId = string | number;
export type Address = string;
export type AddressBytes32 = string;
export type ChainCaip2Id = `${string}:${string}`; // e.g. ethereum:1 or sealevel:1399811149
export type TokenCaip19Id = `${string}:${string}/${string}:${string}`; // e.g. ethereum:1/erc20:0x6b175474e89094c44da98b954eedeac495271d0f
export type HexString = string;
export type Numberish = number | string | bigint;

export type WithAddress<T> = T & {
  address: Address;
};

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
  mailbox_domain: Domain;
  merkle_tree_hook_address: Address;
};

/**
 * Shape of a checkpoint in S3 as published by the agent.
 */
export type S3CheckpointWithId = {
  value: {
    checkpoint: Checkpoint;
    message_id: HexString;
  };
  signature: SignatureLike;
};

export type S3Checkpoint = {
  value: Checkpoint;
  signature: SignatureLike;
};

export type CallData = {
  to: Address;
  data: string;
  value?: BigNumber;
};

export enum MessageStatus {
  NONE = 0,
  PROCESSED,
}

export type ParsedMessage = {
  version: number;
  nonce: number;
  origin: number;
  sender: string;
  destination: number;
  recipient: string;
  body: string;
};

export type ParsedLegacyMultisigIsmMetadata = {
  checkpointRoot: string;
  checkpointIndex: number;
  originMailbox: string;
  proof: ethers.utils.BytesLike[];
  signatures: ethers.utils.BytesLike[];
  validators: ethers.utils.BytesLike[];
};

export enum InterchainSecurityModuleType {
  MULTISIG = 3,
}
