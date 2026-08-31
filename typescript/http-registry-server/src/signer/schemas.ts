import { z } from 'zod';

import { isCanonicalBase64 } from './encoding.js';

export const MAX_EVM_TRANSACTION_BYTES = 128 * 1024;
// Hex encoding doubles transaction bytes; the remainder covers signature and JSON fields.
export const SIGNER_JSON_PAYLOAD_LIMIT_BYTES = 270 * 1024;

export const EncodedBytesSchema = z.discriminatedUnion('encoding', [
  z.object({
    encoding: z.literal('hex'),
    value: z
      .string()
      .regex(
        /^(?:[0-9a-f]{2})+$/,
        'Expected lowercase, even-length hex without 0x',
      ),
  }),
  z.object({
    encoding: z.literal('base64'),
    value: z
      .string()
      .refine(isCanonicalBase64, 'Expected canonical padded base64'),
  }),
]);

export type EncodedBytes = z.infer<typeof EncodedBytesSchema>;

export const SignerAccountResponseSchema = z.object({
  chain: z.string().min(1),
  protocol: z.string().min(1),
  address: z.string().min(1),
  curve: z.enum(['secp256k1', 'ed25519']),
});

export type SignerAccountResponse = z.infer<typeof SignerAccountResponseSchema>;

export const SignerTransactionRequestSchema = z.object({
  chain: z.string().min(1),
  transaction: EncodedBytesSchema,
});

export type SignerTransactionRequest = z.infer<
  typeof SignerTransactionRequestSchema
>;

const RequestedChainEchoSchema = z
  .string()
  .min(1)
  .describe('Echoes the requested chain; not derived from transaction bytes');

export const SignerTransactionResponseSchema = z.object({
  chain: RequestedChainEchoSchema,
  signerAddress: z.string().min(1),
  signedTransaction: EncodedBytesSchema,
  backendRequestId: z.string().min(1).optional(),
});

export type SignerTransactionResponse = z.infer<
  typeof SignerTransactionResponseSchema
>;

const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
type JsonValue =
  | z.infer<typeof JsonPrimitiveSchema>
  | JsonValue[]
  | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const Eip712PayloadSchema = z.object({
  types: z.record(
    z.string(),
    z.array(
      z.object({
        name: z.string(),
        type: z.string().min(1),
      }),
    ),
  ),
  primaryType: z.string().min(1),
  domain: z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    chainId: z.union([z.string(), z.number()]).optional(),
    verifyingContract: z.string().optional(),
    salt: z.string().optional(),
  }),
  message: z.record(z.string(), JsonValueSchema),
});

export type Eip712Payload = z.infer<typeof Eip712PayloadSchema>;

export const SignerTypedDataRequestSchema = z.object({
  chain: z.string().min(1),
  typedData: Eip712PayloadSchema,
});

export type SignerTypedDataRequest = z.infer<
  typeof SignerTypedDataRequestSchema
>;

export const SignerTypedDataResponseSchema = z.object({
  chain: z.string().min(1),
  signerAddress: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  backendRequestId: z.string().min(1).optional(),
});

export type SignerTypedDataResponse = z.infer<
  typeof SignerTypedDataResponseSchema
>;

export function decodeEncodedBytes(
  encoded: EncodedBytes,
  maxBytes: number,
): Uint8Array {
  const bytes = Buffer.from(encoded.value, encoded.encoding);
  if (bytes.length === 0) throw new Error('Encoded bytes must not be empty');
  if (bytes.length > maxBytes) {
    throw new Error(`Encoded bytes exceed ${maxBytes} byte limit`);
  }
  return bytes;
}

export function encodeBytes(
  bytes: Uint8Array,
  encoding: EncodedBytes['encoding'],
): EncodedBytes {
  if (encoding === 'hex') {
    return { encoding: 'hex', value: Buffer.from(bytes).toString('hex') };
  }
  return { encoding: 'base64', value: Buffer.from(bytes).toString('base64') };
}
