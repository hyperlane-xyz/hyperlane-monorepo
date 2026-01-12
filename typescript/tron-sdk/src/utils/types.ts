// TODO: TRON
export type TronTransaction = any;
export type TronReceipt = any;

export interface IABI {
  contractName: string;
  abi: any[];
  bytecode: string;
  deployedBytecode: string;
}
