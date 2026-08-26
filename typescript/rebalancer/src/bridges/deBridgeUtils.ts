import { z } from 'zod';

import {
  addressToBytesTron,
  assert,
  bytesToAddressTron,
  isValidAddressEvm,
  isValidAddressSealevel,
  isValidAddressTron,
} from '@hyperlane-xyz/utils';

export const DEBRIDGE_API_BASE = 'https://dln.debridge.finance/v1.0';
export const DEBRIDGE_STATUS_API = 'https://api.dln.trade/v1.0';
export const DEBRIDGE_TOOL = 'debridge';

export const HYPERLANE_TO_DEBRIDGE_CHAIN_ID: Record<number, number> = {
  1: 1,
  56: 56,
  42161: 42161,
  9745: 100000028,
  728126428: 100000026,
  1399811149: 7565164,
};

export const DEBRIDGE_TRON_CHAIN_ID = 100000026;
export const DEBRIDGE_SOLANA_CHAIN_ID = 7565164;

const DecimalStringSchema = z.string().max(78).regex(/^\d+$/);
const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const TransactionDataSchema = z
  .string()
  .max(1_000_000)
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/);

export const DeBridgeTokenEstimationSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string().min(1),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(255),
  amount: DecimalStringSchema,
  approximateUsdValue: z.number().finite().optional(),
});

export const DeBridgeQuoteResponseSchema = z.object({
  estimation: z.object({
    srcChainTokenIn: DeBridgeTokenEstimationSchema,
    dstChainTokenOut: DeBridgeTokenEstimationSchema,
  }),
  orderId: Bytes32Schema.optional(),
  fixFee: DecimalStringSchema.optional(),
  protocolFee: DecimalStringSchema.optional(),
});

export const DeBridgeCreateTxResponseSchema =
  DeBridgeQuoteResponseSchema.extend({
    orderId: Bytes32Schema,
    fixFee: DecimalStringSchema,
    tx: z.object({
      to: z.string().optional(),
      data: TransactionDataSchema,
      value: DecimalStringSchema.optional(),
    }),
  });

export const DeBridgeOrderStatusResponseSchema = z.object({
  orderId: Bytes32Schema,
  status: z.enum([
    'None',
    'Created',
    'Fulfilled',
    'SentUnlock',
    'OrderCancelled',
    'SentOrderCancel',
    'ClaimedUnlock',
    'ClaimedOrderCancel',
  ]),
  fulfilledDstEventMetadata: z
    .object({
      transactionHash: z
        .object({ stringValue: z.string().min(1).optional() })
        .optional(),
      receivedAmount: z
        .object({ bigIntegerValue: DecimalStringSchema.optional() })
        .optional(),
    })
    .optional(),
});

export const DeBridgeApiErrorSchema = z.object({
  errorCode: z.number().optional(),
  errorId: z.string().optional(),
  errorMessage: z.string().min(1),
});

export type DeBridgeTokenEstimation = z.infer<
  typeof DeBridgeTokenEstimationSchema
>;
export type DeBridgeQuoteResponse = z.infer<typeof DeBridgeQuoteResponseSchema>;
export type DeBridgeCreateTxResponse = z.infer<
  typeof DeBridgeCreateTxResponseSchema
>;
export type DeBridgeOrderStatusResponse = z.infer<
  typeof DeBridgeOrderStatusResponseSchema
>;

export function hyperlaneChainIdToDebridge(chainId: number): number {
  const debridgeChainId = HYPERLANE_TO_DEBRIDGE_CHAIN_ID[chainId];
  assert(
    debridgeChainId !== undefined,
    `Chain ${chainId} is not supported by deBridge integration`,
  );
  return debridgeChainId;
}

export function isDebridgeTronChain(debridgeChainId: number): boolean {
  return debridgeChainId === DEBRIDGE_TRON_CHAIN_ID;
}

export function isDebridgeSolanaChain(debridgeChainId: number): boolean {
  return debridgeChainId === DEBRIDGE_SOLANA_CHAIN_ID;
}

export function formatAddressForDebridge(
  address: string,
  debridgeChainId: number,
): string {
  if (isDebridgeTronChain(debridgeChainId)) {
    if (address.startsWith('T')) {
      assert(isValidAddressTron(address), `Invalid Tron address: ${address}`);
      const canonical = bytesToAddressTron(addressToBytesTron(address));
      assert(
        canonical === address,
        `Invalid Tron address checksum: ${address}`,
      );
      return address;
    }

    const withoutHexPrefix = address.startsWith('0x')
      ? address.slice(2)
      : address;
    const withoutPrefix = /^41[0-9a-fA-F]{40}$/.test(withoutHexPrefix)
      ? withoutHexPrefix.slice(2)
      : withoutHexPrefix;
    assert(
      /^[0-9a-fA-F]{40}$/.test(withoutPrefix),
      `Invalid Tron hex address: ${address}`,
    );
    return bytesToAddressTron(Buffer.from(withoutPrefix, 'hex'));
  }

  if (isDebridgeSolanaChain(debridgeChainId)) {
    assert(
      isValidAddressSealevel(address),
      `Invalid Solana address: ${address}`,
    );
    return address;
  }

  assert(isValidAddressEvm(address), `Invalid EVM address: ${address}`);
  return address;
}

export function parseDeBridgeQuoteResponse(
  input: unknown,
): DeBridgeQuoteResponse {
  throwIfDeBridgeApiError(input);
  return DeBridgeQuoteResponseSchema.parse(input);
}

export function parseDeBridgeCreateTxResponse(
  input: unknown,
): DeBridgeCreateTxResponse {
  throwIfDeBridgeApiError(input);
  return DeBridgeCreateTxResponseSchema.parse(input);
}

export function parseDeBridgeOrderStatusResponse(
  input: unknown,
): DeBridgeOrderStatusResponse {
  throwIfDeBridgeApiError(input);
  return DeBridgeOrderStatusResponseSchema.parse(input);
}

function throwIfDeBridgeApiError(input: unknown): void {
  const result = DeBridgeApiErrorSchema.safeParse(input);
  if (result.success) {
    const details = result.data.errorId
      ? `${result.data.errorId}: ${result.data.errorMessage}`
      : result.data.errorMessage;
    throw new Error(`deBridge API error: ${details}`);
  }
}
