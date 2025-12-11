import { ConfirmedTransactionJSON, ExecuteOptions } from '@provablehq/sdk';

export interface AleoTransaction extends ExecuteOptions {}
export interface AleoReceipt extends ConfirmedTransactionJSON {
  transactionHash: string;
}

export enum AleoTokenType {
  NATIVE = 0,
  SYNTHETIC = 1,
  COLLATERAL = 2,
}

export enum AleoHookType {
  CUSTOM = 0,
  MERKLE_TREE = 3,
  INTERCHAIN_GAS_PAYMASTER = 4,
  PAUSABLE = 7,
}

export enum AleoIsmType {
  TEST_ISM = 0,
  ROUTING = 1,
  MERKLE_ROOT_MULTISIG = 4,
  MESSAGE_ID_MULTISIG = 5,
}
