// TODO DE-DUPE WITH EXPLORER
// Mostly copied from explorer src/types.ts
export enum MessageStatus {
  Unknown = 'unknown',
  Pending = 'pending',
  Delivered = 'delivered',
  Failing = 'failing',
}

export interface MessageTxStub {
  timestamp: number;
  hash: string;
  from: Address;
}

export interface MessageTx extends MessageTxStub {
  to: Address;
  blockHash: string;
  blockNumber: number;
  mailbox: Address;
  nonce: number;
  gasLimit: number;
  gasPrice: number;
  effectiveGasPrice;
  gasUsed: number;
  cumulativeGasUsed: number;
  maxFeePerGas: number;
  maxPriorityPerGas: number;
}

export interface MessageStub {
  status: MessageStatus;
  id: string; // Database id
  msgId: string; // Message hash
  nonce: number; // formerly leafIndex
  sender: Address;
  recipient: Address;
  originChainId: number;
  originDomainId: number;
  destinationChainId: number;
  destinationDomainId: number;
  origin: MessageTxStub;
  destination?: MessageTxStub;
  isPiMsg?: boolean;
}

export interface Message extends MessageStub {
  body: string;
  decodedBody?: string;
  origin: MessageTx;
  destination?: MessageTx;
  totalGasAmount?: string;
  totalPayment?: string;
  numPayments?: number;
}

export type ApiMessage = Omit<
  Message,
  | 'msgId' // use id field for msgId
  | 'decodedBody'
>;

export interface PartialMessage {
  status: MessageStatus;
  nonce: number;
  originChainId: number;
  originDomainId: number;
  destinationChainId: number;
  destinationDomainId: number;
  origin: { blockNumber: number; timestamp: number };
  destination?: { blockNumber: number; timestamp: number };
}

export enum MessageStage {
  Preparing = 0,
  Sent = 1,
  Finalized = 2,
  Validated = 3,
  Relayed = 4,
}

export type StageTimings = {
  [MessageStage.Finalized]: number | null;
  [MessageStage.Validated]: number | null;
  [MessageStage.Relayed]: number | null;
};
