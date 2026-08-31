import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import type { ProtocolType } from '@hyperlane-xyz/utils';

import type { Eip712Payload, SignerAccountResponse } from './schemas.js';

export type SignerAccount = Pick<SignerAccountResponse, 'address' | 'curve'>;

export interface TransactionSignerBackend {
  getAccount(): Promise<SignerAccount>;
  healthCheck(): Promise<void>;
  signTransaction(
    protocol: ProtocolType,
    unsignedTransaction: Uint8Array,
  ): Promise<{
    signedTransaction: Uint8Array;
    backendRequestId?: string;
  }>;
  signTypedData?(
    typedData: Eip712Payload,
  ): Promise<{ signature: string; backendRequestId?: string }>;
}

export type SignerBackends = Partial<
  Record<ProtocolType, TransactionSignerBackend>
>;

export interface TransactionCodec {
  validateUnsigned(
    transaction: Uint8Array,
    metadata: ChainMetadata,
    account: SignerAccount,
  ): void | Promise<void>;
  validateSigned(
    unsignedTransaction: Uint8Array,
    signedTransaction: Uint8Array,
    metadata: ChainMetadata,
    account: SignerAccount,
  ):
    | Record<string, string | number | boolean | undefined>
    | Promise<Record<string, string | number | boolean | undefined>>;
}

export type SignerBackendErrorKind =
  | 'denied'
  | 'approvalRequired'
  | 'unavailable';

export class SignerBackendError extends Error {
  constructor(
    public readonly kind: SignerBackendErrorKind,
    message: string,
    public readonly backendRequestId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SignerBackendError';
  }
}
