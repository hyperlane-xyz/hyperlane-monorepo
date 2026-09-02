import { ethers } from 'ethers';
import type { Logger } from 'pino';
import { address as parseSvmAddress } from '@solana/kit';

import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ChainTechnicalStack } from '@hyperlane-xyz/sdk';
import { ProtocolType, eqAddressEvm } from '@hyperlane-xyz/utils';

import { ApiError } from '../errors/ApiError.js';
import type { RegistryService } from '../services/registryService.js';
import { EvmTransactionCodec } from './evmCodec.js';
import {
  type Eip712Payload,
  type EncodedBytes,
  type SignerAccountResponse,
  type SignerTransactionRequest,
  type SignerTransactionResponse,
  type SignerTypedDataRequest,
  type SignerTypedDataResponse,
  MAX_EVM_TRANSACTION_BYTES,
  decodeEncodedBytes,
  encodeBytes,
} from './schemas.js';
import { MAX_SVM_TRANSACTION_BYTES, SvmTransactionCodec } from './svmCodec.js';
import {
  SignerBackendError,
  type SignerAccount,
  type SignerBackends,
  type TransactionCodec,
  type TransactionSignerBackend,
} from './types.js';

const MAX_VALIDATION_LOG_FIELD_LENGTH = 64;

function apiError(message: string, status: number): ApiError {
  return new ApiError(message, status);
}

function safeBackendError(error: unknown): ApiError {
  if (!(error instanceof SignerBackendError)) {
    return apiError('Signing backend is unavailable', 502);
  }
  switch (error.kind) {
    case 'denied':
      return apiError('Signing request was denied by backend policy', 403);
    case 'approvalRequired':
      return apiError(
        'Signing request requires unsupported backend approval',
        409,
      );
    case 'unavailable':
      return apiError('Signing backend is unavailable', 502);
  }
}

function validationErrorLogFields(error: unknown): {
  validationErrorType: string;
  validationErrorCode?: string | number;
} {
  const validationErrorType = (
    error instanceof Error ? error.name : typeof error
  ).slice(0, MAX_VALIDATION_LOG_FIELD_LENGTH);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  const validationErrorCode =
    typeof code === 'string'
      ? code.slice(0, MAX_VALIDATION_LOG_FIELD_LENGTH)
      : typeof code === 'number'
        ? code
        : undefined;
  return { validationErrorType, validationErrorCode };
}

function transactionEncoding(protocol: ProtocolType): EncodedBytes['encoding'] {
  switch (protocol) {
    case ProtocolType.Ethereum:
      return 'hex';
    case ProtocolType.Sealevel:
      return 'base64';
    default:
      throw apiError(`Protocol ${protocol} is not supported for signing`, 404);
  }
}

function transactionLimit(protocol: ProtocolType): number {
  return protocol === ProtocolType.Sealevel
    ? MAX_SVM_TRANSACTION_BYTES
    : MAX_EVM_TRANSACTION_BYTES;
}

function typedDataTypes(payload: Eip712Payload) {
  const { EIP712Domain: _domain, ...types } = payload.types;
  return types;
}

function validateAccount(
  protocol: ProtocolType,
  account: SignerAccount,
): SignerAccount {
  try {
    if (protocol === ProtocolType.Ethereum) {
      if (account.curve !== 'secp256k1') throw new Error('Wrong curve');
      return { ...account, address: ethers.utils.getAddress(account.address) };
    }
    if (protocol === ProtocolType.Sealevel) {
      if (account.curve !== 'ed25519') throw new Error('Wrong curve');
      parseSvmAddress(account.address);
      return account;
    }
  } catch {
    throw apiError('Signing backend returned an invalid account', 502);
  }
  throw apiError(`Protocol ${protocol} is not supported for signing`, 404);
}

export class SignerService {
  private readonly codecs: Partial<Record<ProtocolType, TransactionCodec>> = {
    [ProtocolType.Ethereum]: new EvmTransactionCodec(),
    [ProtocolType.Sealevel]: new SvmTransactionCodec(),
  };

  constructor(
    private readonly registryService: RegistryService,
    private readonly backends: SignerBackends,
    private readonly logger: Logger,
  ) {}

  private async getContext(chain: string): Promise<{
    metadata: ChainMetadata;
    backend: TransactionSignerBackend;
    account: SignerAccount;
  }> {
    const metadata = await this.registryService.withRegistry(
      async (registry) => {
        const chains = await registry.getChains();
        if (!chains.includes(chain)) return null;
        return registry.getChainMetadata(chain);
      },
    );
    if (!metadata) throw apiError(`Chain ${chain} not found`, 404);
    const backend = this.backends[metadata.protocol];
    if (!backend) {
      throw apiError(
        `No signer configured for protocol ${metadata.protocol}`,
        404,
      );
    }
    let account: SignerAccount;
    try {
      account = validateAccount(metadata.protocol, await backend.getAccount());
    } catch (error) {
      this.logger.warn(
        { protocol: metadata.protocol },
        'Signer account lookup failed',
      );
      throw safeBackendError(error);
    }
    return { metadata, backend, account };
  }

  async getAccount(chain: string): Promise<SignerAccountResponse> {
    const { metadata, account } = await this.getContext(chain);
    return {
      chain,
      protocol: metadata.protocol,
      ...account,
    };
  }

  async signTransaction(
    request: SignerTransactionRequest,
  ): Promise<SignerTransactionResponse> {
    const { metadata, backend, account } = await this.getContext(request.chain);
    const codec = this.codecs[metadata.protocol];
    if (!codec) {
      throw apiError(
        `Protocol ${metadata.protocol} is not supported for signing`,
        404,
      );
    }
    const expectedEncoding = transactionEncoding(metadata.protocol);
    if (request.transaction.encoding !== expectedEncoding) {
      throw apiError(
        `${metadata.protocol} transactions require ${expectedEncoding}`,
        400,
      );
    }

    let unsignedTransaction: Uint8Array;
    try {
      unsignedTransaction = decodeEncodedBytes(
        request.transaction,
        transactionLimit(metadata.protocol),
      );
      await codec.validateUnsigned(unsignedTransaction, metadata, account);
    } catch (error) {
      throw apiError(
        error instanceof Error ? error.message : 'Invalid unsigned transaction',
        400,
      );
    }

    let result: Awaited<
      ReturnType<TransactionSignerBackend['signTransaction']>
    >;
    try {
      result = await backend.signTransaction(
        metadata.protocol,
        unsignedTransaction,
      );
    } catch (error) {
      this.logger.warn(
        { protocol: metadata.protocol },
        'Transaction signing failed',
      );
      throw safeBackendError(error);
    }

    let auditFields: Record<string, string | number | boolean | undefined>;
    try {
      auditFields = await codec.validateSigned(
        unsignedTransaction,
        result.signedTransaction,
        metadata,
        account,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          protocol: metadata.protocol,
          backendRequestId: result.backendRequestId,
          ...validationErrorLogFields(error),
        },
        'Signing backend returned an invalid transaction',
      );
      throw apiError('Signing backend returned an invalid transaction', 502);
    }
    this.logger.info(
      {
        requestedChain: request.chain,
        chainVerified: metadata.protocol === ProtocolType.Ethereum,
        protocol: metadata.protocol,
        backendRequestId: result.backendRequestId,
        ...auditFields,
      },
      'Transaction signed',
    );

    return {
      chain: request.chain,
      signerAddress: account.address,
      signedTransaction: encodeBytes(
        result.signedTransaction,
        expectedEncoding,
      ),
      backendRequestId: result.backendRequestId,
    };
  }

  async signTypedData(
    request: SignerTypedDataRequest,
  ): Promise<SignerTypedDataResponse> {
    const { metadata, backend, account } = await this.getContext(request.chain);
    if (
      metadata.protocol !== ProtocolType.Ethereum ||
      metadata.technicalStack === ChainTechnicalStack.ZkSync
    ) {
      throw apiError('Typed-data signing requires standard Ethereum', 400);
    }
    if (!backend.signTypedData) {
      throw apiError(
        'Typed-data signing is not supported by this backend',
        404,
      );
    }
    const types = typedDataTypes(request.typedData);
    try {
      const encoder = ethers.utils._TypedDataEncoder.from(types);
      if (encoder.primaryType !== request.typedData.primaryType) {
        throw new Error('Primary type mismatch');
      }
      ethers.utils._TypedDataEncoder.hash(
        request.typedData.domain,
        types,
        request.typedData.message,
      );
    } catch {
      throw apiError('Typed-data payload is malformed', 400);
    }
    const domainChainId = request.typedData.domain.chainId;
    let matchesChain = false;
    try {
      matchesChain =
        domainChainId !== undefined &&
        ethers.BigNumber.from(domainChainId).eq(metadata.chainId);
    } catch {
      // Malformed domain values are caller input, not server errors.
    }
    if (!matchesChain) {
      throw apiError(
        'Typed-data domain chain ID does not match registry metadata',
        400,
      );
    }

    let result: Awaited<
      ReturnType<NonNullable<TransactionSignerBackend['signTypedData']>>
    >;
    try {
      result = await backend.signTypedData(request.typedData);
    } catch (error) {
      this.logger.warn(
        { protocol: metadata.protocol },
        'Typed-data signing failed',
      );
      throw safeBackendError(error);
    }

    try {
      const recovered = ethers.utils.verifyTypedData(
        request.typedData.domain,
        types,
        request.typedData.message,
        result.signature,
      );
      if (!eqAddressEvm(recovered, account.address)) {
        throw new Error('Unexpected signer');
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          protocol: metadata.protocol,
          backendRequestId: result.backendRequestId,
          ...validationErrorLogFields(error),
        },
        'Signing backend returned an invalid typed-data signature',
      );
      throw apiError(
        'Signing backend returned an invalid typed-data signature',
        502,
      );
    }

    this.logger.info(
      {
        requestedChain: request.chain,
        chainVerified: true,
        protocol: metadata.protocol,
        signer: account.address,
        primaryType: request.typedData.primaryType,
        verifyingContract: request.typedData.domain.verifyingContract,
        backendRequestId: result.backendRequestId,
      },
      'Typed data signed',
    );
    return {
      chain: request.chain,
      signerAddress: account.address,
      signature: result.signature,
      backendRequestId: result.backendRequestId,
    };
  }
}
