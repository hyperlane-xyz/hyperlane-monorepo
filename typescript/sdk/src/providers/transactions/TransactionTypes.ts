import {
  EthersV5Transaction,
  EthersV5TransactionReceipt,
} from '../ProviderType.js';

export type EV5Tx = EthersV5Transaction['transaction'];
export type EV5Receipt = EthersV5TransactionReceipt['receipt'];
