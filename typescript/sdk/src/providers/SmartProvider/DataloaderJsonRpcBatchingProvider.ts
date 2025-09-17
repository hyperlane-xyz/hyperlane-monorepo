import { Networkish } from '@ethersproject/providers';
import DataLoader from 'dataloader';
import { ethers } from 'ethers';

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  error?: {
    code: number;
    data: any;
    message: string;
  };
  result: any;
};

type RawEthersJsRequest = { method: string; params: any[] };

function rawRequestToId(request: RawEthersJsRequest): string {
  return JSON.stringify(request);
}

function idToRawRequest(id: string): RawEthersJsRequest {
  return JSON.parse(id);
}

export enum AllowedEvmReadMethods {
  // Account Information
  GET_BALANCE = 'eth_getBalance',
  GET_CODE = 'eth_getCode',
  GET_STORAGE_AT = 'eth_getStorageAt',

  // Block Information
  BLOCK_NUMBER = 'eth_blockNumber',
  GET_BLOCK_BY_HASH = 'eth_getBlockByHash',
  GET_BLOCK_BY_NUMBER = 'eth_getBlockByNumber',

  // Transaction Information
  GET_TRANSACTION_BY_HASH = 'eth_getTransactionByHash',
  GET_TRANSACTION_RECEIPT = 'eth_getTransactionReceipt',

  // Contract Calls and Estimation
  CALL = 'eth_call',
  ESTIMATE_GAS = 'eth_estimateGas',

  // Network and Protocol Information
  CHAIN_ID = 'eth_chainId',
  GAS_PRICE = 'eth_gasPrice',
  MAX_PRIORITY_FEE_PER_GAS = 'eth_maxPriorityFeePerGas',

  // Logs and Events
  GET_LOGS = 'eth_getLogs',

  // EIP-1559 Methods
  GET_BASE_FEE_PER_GAS = 'eth_getBaseFeePerGas',
}

const allowedEvmReadOperations = new Set(Object.values(AllowedEvmReadMethods));

export class DataLoaderJsonRpcBatchingProvider extends ethers.providers
  .StaticJsonRpcProvider {
  private readonly loader: DataLoader<string, string>;

  constructor(
    rpcConfig: ethers.utils.ConnectionInfo | string | undefined,
    network: Networkish,
  ) {
    super(rpcConfig, network);

    this.loader = new DataLoader((requests) =>
      this.processRequestBatch(requests.map((curr) => idToRawRequest(curr))),
    );
  }

  async send(method: string, params: Array<any>) {
    if (!allowedEvmReadOperations.has(method as AllowedEvmReadMethods)) {
      return super.send(method, params);
    }

    const res = this.loader.load(rawRequestToId({ method, params }));
    if (res instanceof Error) {
      throw res;
    }

    return res;
  }

  async processRequestBatch(
    requests: ReadonlyArray<RawEthersJsRequest>,
  ): Promise<Array<string | Error>> {
    if (requests.length === 1) {
      const result = await super.send(requests[0].method, requests[0].params);

      return [result];
    }

    const batchRequest = requests.map((item, id) => ({
      jsonrpc: '2.0',
      id,
      method: item.method,
      params: item.params,
    }));

    const response = await fetch(this.connection.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchRequest),
    });

    const results: JsonRpcResponse[] = await response.json();

    return results.map((result) => {
      return result.error ? new Error(result.error.message) : result.result;
    });
  }
}
