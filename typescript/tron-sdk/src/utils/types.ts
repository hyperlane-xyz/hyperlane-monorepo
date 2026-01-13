export type TronTransaction = {
  visible: boolean;
  txID: string;
  raw_data_hex: string;
  raw_data: {
    contract: any[];
    ref_block_bytes: string;
    ref_block_hash: string;
    expiration: number;
    timestamp: number;
    fee_limit?: unknown;
  };
};

export type TronReceipt = {
  id: string;
  fee: number;
  blockNumber: number;
  blockTimeStamp: number;
  contractResult: string[];
  contract_address: string;
  receipt: {
    energy_fee: number;
    energy_usage_total: number;
    net_fee: number;
    result: 'SUCCESS' | 'REVERTED' | 'FAILED';
  };
};

export interface IABI {
  contractName: string;
  abi: any[];
  bytecode: string;
  deployedBytecode: string;
}
