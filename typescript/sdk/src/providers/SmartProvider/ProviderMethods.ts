export interface IProviderMethods {
  readonly supportedMethods: ProviderMethod[];
}

export enum ProviderMethod {
  Call = 'call',
  EstimateGas = 'estimateGas',
  GetBalance = 'getBalance',
  GetBlock = 'getBlock',
  GetBlockNumber = 'getBlockNumber',
  GetCode = 'getCode',
  GetGasPrice = 'getGasPrice',
  GetStorageAt = 'getStorageAt',
  GetTransaction = 'getTransaction',
  GetTransactionCount = 'getTransactionCount',
  GetTransactionReceipt = 'getTransactionReceipt',
  GetLogs = 'getLogs',
  SendTransaction = 'sendTransaction',
  MaxPriorityFeePerGas = 'maxPriorityFeePerGas',
  ReadRpc = 'readRpc',
}

// Raw RPC access is deliberately read-only: retrying a submission can duplicate it.
export const ReadRpcMethods: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getTransactionCount',
  'eth_call',
  'eth_estimateGas',
  'seismic_getTeePublicKey',
]);

export const AllProviderMethods = Object.values(ProviderMethod);

export function excludeProviderMethods(
  exclude: ProviderMethod[],
): ProviderMethod[] {
  return AllProviderMethods.filter((m) => !exclude.includes(m));
}
