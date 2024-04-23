import SafeApiKit from '@safe-global/api-kit';

import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types.js';

import { HyperlaneTx } from './HyperlaneTx.js';

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

export type GnosisSafeHyperlaneTxProps = {
  chain: ChainName;
  safeAddress: Address;
  safeTransactionData: SafeTransactionData;
  safeTxHash: string;
  senderAddress: Address;
  senderSignature: string;
  safeService: SafeApiKit.default;
};

export class GnosisSafeHyperlaneTx
  extends HyperlaneTx
  implements GnosisSafeTxProps
{
  public readonly chain: ChainName;
  public readonly safeAddress: Address;
  public readonly safeTransactionData: SafeTransactionData;
  public readonly safeTxHash: string;
  public readonly senderAddress: Address;
  public readonly senderSignature: string;
  public readonly safeService: SafeApiKit.default;

  constructor({
    chain,
    safeAddress,
    safeTransactionData,
    safeTxHash,
    senderAddress,
    senderSignature,
    safeService,
  }: GnosisSafeHyperlaneTxProps) {
    super();
    this.chain = chain;
    this.safeAddress = safeAddress;
    this.safeTransactionData = safeTransactionData;
    this.safeTxHash = safeTxHash;
    this.senderAddress = senderAddress;
    this.senderSignature = senderSignature;
    this.safeService = safeService;
  }
}
