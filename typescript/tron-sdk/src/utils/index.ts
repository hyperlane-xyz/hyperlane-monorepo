import { TronWeb } from 'tronweb';

import { IABI } from './types.js';

export const TRON_EMPTY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
export const TRON_EMPTY_MESSAGE =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
export const TRON_MAX_FEE = 100_000_000; // 100 TRX should be sufficient for every reasonable transaction

export async function createDeploymentTransaction(
  tronweb: Readonly<TronWeb>,
  abi: IABI,
  signer: string,
  parameters: unknown[],
): Promise<any> {
  const options = {
    feeLimit: 1_000_000_000,
    callValue: 0,
    userFeePercentage: 100,
    originEnergyLimit: 10_000_000,
    abi: abi.abi,
    bytecode: abi.bytecode,
    parameters,
    name: abi.contractName,
  };

  return tronweb.transactionBuilder.createSmartContract(options, signer);
}
