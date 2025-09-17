import { Networkish } from '@ethersproject/providers';
import DataLoader from 'dataloader';
import { ethers } from 'ethers';

import { assert, rootLogger } from '@hyperlane-xyz/utils';

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  error?: {
    code: number;
    data?: any;
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
  private readonly loader: DataLoader<string, string | Error>;
  protected batchingProviderLogger = rootLogger.child({
    module: `${DataLoaderJsonRpcBatchingProvider.name}:${this.network.chainId}`,
  });

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
      this.batchingProviderLogger.debug(
        `EVM RPC method "${method}" is not in the batch allowlist. Sending to the RPC`,
      );
      return super.send(method, params);
    }

    this.batchingProviderLogger.debug(
      `Batching EVM RPC method "${method}" request`,
    );

    const res = await this.loader.load(rawRequestToId({ method, params }));
    if (res instanceof Error) {
      throw res;
    }

    return res;
  }

  async processRequestBatch(
    requests: ReadonlyArray<RawEthersJsRequest>,
  ): Promise<Array<string | Error>> {
    const batchSize = requests.length;
    this.batchingProviderLogger.debug(`Current batch size is ${batchSize}`);

    if (batchSize === 1) {
      const result = await super.send(requests[0].method, requests[0].params);

      return [result];
    }

    const startingReqId = this._nextId;
    this._nextId += batchSize;

    const batchRequest = requests.map((item, idx) => ({
      jsonrpc: '2.0',
      id: startingReqId + idx,
      method: item.method,
      params: item.params,
    }));

    const response = await fetch(this.connection.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchRequest),
    });

    // If the overall request failed we need to
    // return an error for each one of the original requests
    if (!response.ok) {
      const errMsg = `Batch request failed with error code ${response.statusText}`;
      this.batchingProviderLogger.debug(errMsg);

      const err = new Error(errMsg);
      return Array(batchSize).fill(err);
    }

    // Technically the RPC might not return a value but as
    // all the allowed methods in AllowedEvmReadMethods are not notification
    // methods, we don't check this here.
    let results: JsonRpcResponse | JsonRpcResponse[];
    try {
      results = await response.json();
    } catch (error) {
      const errMsg = `Invalid JSON response for json rpc batch: ${(error as Error).message}`;
      this.batchingProviderLogger.debug(errMsg, error);

      const err = new Error(errMsg);
      return Array(batchSize).fill(err);
    }

    // if the response is a single object,
    // the request might probably not have been
    // parsed correctly on the destination server
    if (!Array.isArray(results) && results.error) {
      const err: any = new Error(results.error.message);
      err.code = results.error.code;
      err.data = results.error.data;

      return Array(batchSize).fill(err);
    }

    // At this point we are sure that the response object is an array.
    // As responses can be returned in any order to the caller, we use the id
    // to reorganize the responses in the expected original order
    const responseIdMap: Record<number, string | Error> = Object.fromEntries(
      (results as JsonRpcResponse[]).map((result) => {
        if (result.error) {
          // Ported from the original ethers.js code base to keep compatibility
          // with caller code if it makes any assumption on the presence of these fields
          // https://github.com/ethers-io/ethers.js/blob/v5.7/packages/providers/src.ts/json-rpc-provider.ts#L139-#L146
          const err: any = new Error(result.error.message);
          err.code = result.error.code;
          err.data = result.error.data;

          return [result.id, err];
        }

        return [result.id, result.result];
      }),
    );

    return batchRequest.map(({ id }) => {
      const response = responseIdMap[id];
      assert(
        response,
        `A json rpc response was not found for request with id ${id}`,
      );

      return response;
    });
  }
}
