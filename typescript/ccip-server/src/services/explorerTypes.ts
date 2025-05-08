// TODO de-dupe this types with the Explorer by moving them to a shared lib
// These were originally imported from the explorer package but there were two issues
// 1. The explorer is not structured to be a lib (it's an app)
// 2. The explorer's deps on monorepo packages created circular deps leading to transitive deps conflicts

type Address = string;

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
  effectiveGasPrice: number;
  gasUsed: number;
  cumulativeGasUsed: number;
  maxFeePerGas: number;
  maxPriorityPerGas: number;
}

export interface TransactionInfo {
  from: string;
  transactionHash: string;
  blockNumber: number;
  gasUsed: number;
  timestamp: number;
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
  originTransaction: TransactionInfo;
  destinationTransaction: TransactionInfo;
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
