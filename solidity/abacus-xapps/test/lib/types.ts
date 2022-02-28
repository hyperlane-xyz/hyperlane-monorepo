import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BytesLike, ethers } from 'ethers';
import { BridgeMessageTypes } from './bridge';

/********* HRE *********/
export interface HardhatBridgeHelpers {
  BridgeMessageTypes: typeof BridgeMessageTypes;
  typeToByte: Function;
  MESSAGE_LEN: MessageLen;
  serializeTransferAction: Function;
  serializeDetailsAction: Function;
  serializeRequestDetailsAction: Function;
  serializeAction: Function;
  serializeTokenId: Function;
  serializeMessage: Function;
}

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    bridge: HardhatBridgeHelpers;
  }
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
  recipient: ethers.BytesLike;
  amount: number | ethers.BytesLike;
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

export interface TokenIdentifier {
  domain: string | number;
  id: BytesLike;
}
