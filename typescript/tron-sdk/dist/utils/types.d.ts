import type { Types } from 'tronweb';
export interface TronSDKTransaction {
    transaction: Types.Transaction | Types.SignedTransaction;
    contractAddress?: string;
}
export interface TronSDKReceipt {
    txId: string;
    blockNumber: number;
    success: boolean;
    contractAddress?: string;
    energyUsed?: number;
    bandwidthUsed?: number;
}
export interface TronSDKOptions {
    rpcUrls: string[];
    chainId: number;
}
//# sourceMappingURL=types.d.ts.map