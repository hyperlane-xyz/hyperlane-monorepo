import { TronWeb } from 'tronweb';

import { IABI } from './types.js';

export const TRON_EMPTY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
export const TRON_EMPTY_MESSAGE =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
export const EIP1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

export function decodeRevertReason(hex: string, tronweb: any): string {
  try {
    if (hex.startsWith('08c379a0')) {
      // Standard Error(string) selector
      const data = '0x' + hex.substring(8);
      // Decode using TronWeb's internal ethers.js util
      return tronweb.utils.abi.decodeParams(['string'], data)[0];
    }
    return `Hex Error: ${hex}`;
  } catch (e) {
    return `Could not decode hex: ${hex}`;
  }
}

export async function createDeploymentTransaction(
  tronweb: Readonly<TronWeb>,
  abi: IABI,
  signer: string,
  parameters: unknown[],
): Promise<any> {
  return tronweb.transactionBuilder.createSmartContract(
    {
      feeLimit: 1_000_000_000,
      callValue: 0,
      abi: abi.abi,
      bytecode: abi.bytecode,
      parameters,
      name: abi.contractName,
    },
    signer,
  );
}
