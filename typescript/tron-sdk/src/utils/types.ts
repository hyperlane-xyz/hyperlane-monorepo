import type { Types } from 'tronweb';

// Transaction type for Tron SDK
export interface TronSDKTransaction {
  // The raw TronWeb transaction object
  transaction: Types.Transaction | Types.SignedTransaction;
  // Contract address if this is a contract deployment
  contractAddress?: string;
}

// Receipt type for Tron SDK
export interface TronSDKReceipt {
  // Transaction ID (hex string without 0x)
  txId: string;
  // Block number where tx was included
  blockNumber: number;
  // Whether the transaction succeeded
  success: boolean;
  // Contract address if this was a deployment (Base58 format)
  contractAddress?: string;
  // Energy used
  energyUsed?: number;
  // Bandwidth used
  bandwidthUsed?: number;
}

// Options for TronProvider/TronSigner
export interface TronSDKOptions {
  rpcUrls: string[];
  chainId: number;
}
