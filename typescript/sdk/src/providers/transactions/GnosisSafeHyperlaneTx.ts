import { Address } from '@hyperlane-xyz/utils';

declare enum OperationType {
  Call = 0,
  DelegateCall = 1,
}
export interface MetaTransactionData {
  to: string;
  value: string;
  data: string;
  operation?: OperationType;
}
export interface SafeTransactionData extends MetaTransactionData {
  operation: OperationType;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
}

export type GnosisSafeTxProps = {
  safeAddress: Address;
};
