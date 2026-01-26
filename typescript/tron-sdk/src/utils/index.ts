import { TronWeb } from 'tronweb';

import { IABI } from './types.js';

export const TRON_EMPTY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
export const TRON_EMPTY_MESSAGE =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
export const TRON_MAX_FEE = 100_000_000; // 100 TRX should be sufficient for every reasonable transaction

export function decodeRevertReason(hex: string, tronweb: any): string {
  try {
    if (hex.startsWith('08c379a0')) {
      // Standard Error(string) selector
      const data = '0x' + hex.substring(8);
      // Decode using TronWeb's internal ethers.js util
      return tronweb.utils.abi.decodeParams(['string'], data)[0];
    }
    return `Hex Error: ${hex}`;
  } catch {
    return `Could not decode hex: ${hex}`;
  }
}

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
