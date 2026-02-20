import { Abi, encodeFunctionData } from 'viem';

export function formatCallData<
  C extends { abi: Abi },
>(destinationContract: C, functionName: string, functionArgs: readonly unknown[]): string {
  return encodeFunctionData({
    abi: destinationContract.abi,
    functionName,
    args: functionArgs as readonly unknown[],
  });
}
