export const TRON_EMPTY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

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
