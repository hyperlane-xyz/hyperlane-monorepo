import type { Contract } from 'ethers';

export function formatCallData<
  C extends Contract,
  I extends Parameters<C['interface']['encodeFunctionData']>,
>(destinationContract: C, functionName: I[0], functionArgs: I[1]): string {
  return destinationContract.interface.encodeFunctionData(
    functionName,
    functionArgs,
  );
}
