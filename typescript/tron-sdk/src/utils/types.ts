import { Address } from '@hyperlane-xyz/utils';

export type TronTransaction = {
  visible: boolean;
  txID: string;
  raw_data_hex: string;
  raw_data: {
    contract: {
      parameter: {
        value: any;
        type_url: string;
      };
      type: any;
    }[];
    ref_block_bytes: string;
    ref_block_hash: string;
    expiration: number;
    timestamp: number;
    fee_limit?: unknown;
  };
};

type HTTPMap<T extends string | number | symbol, U> = Record<T, U>[];

export type TronReceipt = {
  id: string;
  fee: number;
  blockNumber: number;
  blockTimeStamp: number;
  contractResult: string[];
  contract_address: string;
  receipt: {
    energy_usage: number;
    energy_fee: number;
    origin_energy_usage: number;
    energy_usage_total: number;
    net_usage: number;
    net_fee: number;
    result: string;
    energy_penalty_total: number;
  };
  log: {
    address: Address;
    topics: string[];
    data: string;
  }[];
  result?: 'SUCCESS' | 'PENDING' | 'FAILED';
  resMessage: string;
  assetIssueID: string;
  withdraw_amount: number;
  unfreeze_amount: number;
  internal_transactions: {
    hash: string;
    caller_address: string;
    transferTo_address: string;
    callValueInfo: {
      callValue: number;
      tokenId: string;
    }[];
    note: string;
    rejected: boolean;
    extra: string;
  }[];
  exchange_received_amount: number;
  exchange_inject_another_amount: number;
  exchange_withdraw_another_amount: number;
  shielded_transaction_fee: number;
  withdraw_expire_amount: number;
  cancel_unfreezeV2_amount: HTTPMap<string, number>;
  exchange_id: string;
  orderId: string;
  orderDetails: {
    makerOrderId: string;
    takerOrderId: string;
    fillSellQuantity: number;
    fillBuyQuantity: number;
  }[];
  packingFee: number;
};

export interface IABI {
  contractName: string;
  abi: any[];
  bytecode: string;
  deployedBytecode: string;
}

export enum TronIsmTypes {
  MERKLE_ROOT_MULTISIG = 'MerkleRootMultisigIsm',
  MESSAGE_ID_MULTISIG = 'MessageIdMultisigIsm',
  ROUTING_ISM = 'RoutingIsm',
  NOOP_ISM = 'NoopIsm',
}

export enum TronHookTypes {
  MERKLE_TREE = 'merkleTreeHook',
  INTERCHAIN_GAS_PAYMASTER = 'interchainGasPaymaster',
}
