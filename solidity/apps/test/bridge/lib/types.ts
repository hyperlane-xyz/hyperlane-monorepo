import { BytesLike } from 'ethers';

export enum BridgeMessageTypes {
  INVALID = 0,
  TOKEN_ID,
  MESSAGE,
  TRANSFER,
  DETAILS,
  REQUEST_DETAILS,
}

/********* TOKEN BRIDGE *********/

export type MessageLen = {
  identifier: number;
  tokenId: number;
  transfer: number;
  details: number;
  requestDetails: number;
};

export type Action = DetailsAction | TransferAction | RequestDetailsAction;

export type Message = {
  tokenId: TokenIdentifier;
  action: Action;
};

export type TransferAction = {
  type: BridgeMessageTypes.TRANSFER;
  recipient: BytesLike;
  amount: number | BytesLike;
};

export type DetailsAction = {
  type: BridgeMessageTypes.DETAILS;
  name: string;
  symbol: string;
  decimals: number;
};

export type RequestDetailsAction = {
  type: BridgeMessageTypes.REQUEST_DETAILS;
};

export type TokenIdentifier = {
  domain: string | number;
  id: BytesLike;
};
