import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { ContractType } from '@hyperlane-xyz/starknet-core';
import {
  Call,
  GetTransactionReceiptResponse,
  RawArgs,
  RawArgsArray,
} from 'starknet';

export type StarknetInvokeCall = Omit<Call, 'calldata'> & {
  calldata: RawArgsArray;
};

export type StarknetInvokeTx = AnnotatedTx & {
  kind: 'invoke';
  contractAddress: Call['contractAddress'];
  entrypoint: Call['entrypoint'];
  calldata: RawArgsArray;
  calls?: StarknetInvokeCall[];
};

export type StarknetDeployTx = AnnotatedTx & {
  kind: 'deploy';
  contractName: string;
  contractType?: ContractType;
  constructorArgs: RawArgs;
};

export type StarknetAnnotatedTx = StarknetInvokeTx | StarknetDeployTx;

export type StarknetTxReceipt = TxReceipt & {
  transactionHash: string;
  receipt?: GetTransactionReceiptResponse;
  contractAddress?: string;
};
