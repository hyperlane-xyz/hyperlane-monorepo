import {
  type ConfirmedTransactionJSON,
  type ExecuteOptions,
} from '@provablehq/sdk';

import { type Annotated } from '@hyperlane-xyz/utils';

export interface AleoTransaction extends ExecuteOptions {}
export type AnnotatedAleoTransaction = Annotated<AleoTransaction>;
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

// This must be kept in sync with the enum at
// https://github.com/hyperlane-xyz/hyperlane-aleo/blob/50b9d0ba107939bf3d8f634d302fbd7db922165a/ism_manager/src/main.leo#L71-L74
export enum AleoIsmType {
  TEST_ISM = 6,
  ROUTING = 1,
  MERKLE_ROOT_MULTISIG = 4,
  MESSAGE_ID_MULTISIG = 5,
}

export const AleoNetworkId = {
  MAINNET: 0,
  TESTNET: 1,
} as const;

export type AleoNetworkId = (typeof AleoNetworkId)[keyof typeof AleoNetworkId];
