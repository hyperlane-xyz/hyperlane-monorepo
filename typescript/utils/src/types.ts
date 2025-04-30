import type { SignatureLike } from '@ethersproject/bytes';
import type { BigNumber, ethers } from 'ethers';

export enum ProtocolType {
  Ethereum = 'ethereum',
  Sealevel = 'sealevel',
  Cosmos = 'cosmos',
  CosmosNative = 'cosmosnative',
  Starknet = 'starknet',
}
// A type that also allows for literal values of the enum
export type ProtocolTypeValue = `${ProtocolType}`;

export const ProtocolSmallestUnit = {
  [ProtocolType.Ethereum]: 'wei',
  [ProtocolType.Sealevel]: 'lamports',
  [ProtocolType.Cosmos]: 'uATOM',
  [ProtocolType.CosmosNative]: 'uATOM',
  [ProtocolType.Starknet]: 'fri',
};

/********* BASIC TYPES *********/
export type Domain = number;
export type EvmChainId = number;
export type ChainId = string | number;
export type Address = string;
export type AddressBytes32 = string;
export type ChainCaip2Id = `${string}:${string}`; // e.g. ethereum:1 or sealevel:1399811149
export type TokenCaip19Id = `${string}:${string}/${string}:${string}`; // e.g. ethereum:1/erc20:0x6b175474e89094c44da98b954eedeac495271d0f
export type HexString = string;
export type Numberish = number | string | bigint;

export type WithAddress<T> = T extends object
  ? T & {
      address: Address;
    }
  : never;

export type MerkleProof = {
  branch: ethers.utils.BytesLike[];
  leaf: ethers.utils.BytesLike;
  index: number;
};

/********* HYPERLANE CORE *********/
export type Announcement = {
  mailbox_domain: Domain;
  mailbox_address: Address;
  validator: Address;
  storage_location: string;
};

export type Checkpoint = {
  root: string;
  index: number; // safe because 2 ** 32 leaves < Number.MAX_VALUE
  mailbox_domain: Domain;
  merkle_tree_hook_address: Address;
};

export type CheckpointWithId = {
  checkpoint: Checkpoint;
  message_id: HexString;
};

export { SignatureLike };

/**
 * Shape of a checkpoint in S3 as published by the agent.
 */
export type S3CheckpointWithId = {
  value: CheckpointWithId;
  signature: SignatureLike;
};

export type S3Announcement = {
  value: Announcement;
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
  originChain?: string;
  sender: string;
  destination: number;
  destinationChain?: string;
  recipient: string;
  body: string;
};

export type ParsedWarpRouteMessage = {
  recipient: string;
  amount: bigint;
};

export type ParsedLegacyMultisigIsmMetadata = {
  checkpointRoot: string;
  checkpointIndex: number;
  originMailbox: string;
  proof: ethers.utils.BytesLike[];
  signatures: ethers.utils.BytesLike[];
  validators: ethers.utils.BytesLike[];
};

export type Annotated<T> = T & {
  annotation?: string;
};

export type ValidatorMetadata = {
  git_sha: string;
  rpcs?: string[];
  allows_public_rpcs?: boolean;
};
