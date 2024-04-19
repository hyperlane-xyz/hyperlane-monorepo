import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from './HyperlaneTx.js';

enum OperationType {
  Call = 0,
  DelegateCall = 1,
}
interface MetaTransactionData {
  to: string;
  value: string;
  data: string;
  operation?: OperationType;
}
interface SafeTransactionData extends MetaTransactionData {
  operation: OperationType;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
}
type ProposeTransactionProps = {
  safeAddress: string;
  safeTransactionData: SafeTransactionData;
  safeTxHash: string;
  senderAddress: string;
  senderSignature: string;
  origin?: string;
};

export type GnosisSafeTxProps = ProposeTransactionProps & {};

export class GnosisSafeHyperlaneTx
  extends HyperlaneTx
  implements GnosisSafeTxProps
{
  constructor(
    public populatedTx: PopulatedTransaction,
    public safeAddress: string,
    public safeTransactionData: SafeTransactionData,
    public safeTxHash: string,
    public senderAddress: string,
    public senderSignature: string,
    public origin?: string,
  ) {
    super(populatedTx);
    this.safeAddress = safeAddress;
    this.safeTransactionData = safeTransactionData;
    this.safeTxHash = safeTxHash;
    this.senderAddress = senderAddress;
    this.senderSignature = senderSignature;
    this.origin = origin;
  }
}
