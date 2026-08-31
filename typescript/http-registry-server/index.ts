export { HttpServer, HttpServerOptions } from './HttpServer.js';
export { createSignerAuth, validateSignerToken } from './src/signer/auth.js';
export { createSignerErrorHandler } from './src/signer/errorHandler.js';
export { EvmTransactionCodec } from './src/signer/evmCodec.js';
export {
  Eip712PayloadSchema,
  EncodedBytesSchema,
  MAX_EVM_TRANSACTION_BYTES,
  SIGNER_JSON_PAYLOAD_LIMIT_BYTES,
  SignerAccountResponseSchema,
  SignerTransactionRequestSchema,
  SignerTransactionResponseSchema,
  SignerTypedDataRequestSchema,
  SignerTypedDataResponseSchema,
  decodeEncodedBytes,
  encodeBytes,
  type Eip712Payload,
  type EncodedBytes,
  type SignerAccountResponse,
  type SignerTransactionRequest,
  type SignerTransactionResponse,
  type SignerTypedDataRequest,
  type SignerTypedDataResponse,
} from './src/signer/schemas.js';
export { SignerService } from './src/signer/signerService.js';
export { SvmTransactionCodec } from './src/signer/svmCodec.js';
export {
  SignerBackendError,
  type SignerAccount,
  type SignerBackends,
  type SignerBackendErrorKind,
  type TransactionCodec,
  type TransactionSignerBackend,
} from './src/signer/types.js';
