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
}

export const AllProviderMethods = Object.values(ProviderMethod);

export function excludeProviderMethods(
  exclude: ProviderMethod[],
): ProviderMethod[] {
  return AllProviderMethods.filter((m) => !exclude.includes(m));
}
