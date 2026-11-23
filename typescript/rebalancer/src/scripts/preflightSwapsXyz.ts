import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { pino } from 'pino';
import { z } from 'zod';

import { ChainMetadataSchema } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { SwapsXyzBridge } from '../bridges/SwapsXyzBridge.js';
import { SwapsXyzBridgeConfigSchema } from '../config/types.js';
import type { BridgeQuoteParams } from '../interfaces/IExternalBridge.js';

const amountSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(BigInt);
export const SwapsXyzPreflightRequestSchema = z
  .object({
    fromChain: z.number().int().positive(),
    toChain: z.number().int().positive(),
    fromToken: z.string().min(1),
    toToken: z.string().min(1),
    fromAddress: z.string().min(1),
    toAddress: z.string().min(1).optional(),
    fromAmount: amountSchema.optional(),
    toAmount: amountSchema.optional(),
    slippage: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (request) =>
      (request.fromAmount !== undefined) !== (request.toAmount !== undefined),
    'Exactly one of fromAmount or toAmount is required',
  );

/** Runs the production unsigned preparation path with public signer addresses. */
export async function collectSwapsXyzPreflight(
  bridge: SwapsXyzBridge,
  request: BridgeQuoteParams,
) {
  const quote = await bridge.quote(request);
  const prepared = await bridge.prepare(quote);
  assert(prepared.solanaDiagnostics, 'Preflight requires a Sealevel source');
  // Deliberately select public diagnostics; provider payloads and RPC metadata
  // can contain credentials and must not be copied into the sampling artifact.
  return {
    status: 'validated',
    sampledAt: new Date().toISOString(),
    request,
    fromAmount: quote.fromAmount.toString(),
    toAmount: quote.toAmount.toString(),
    toAmountMin: quote.toAmountMin.toString(),
    preparedAt: prepared.preparedAt,
    ...prepared.solanaDiagnostics,
  };
}

function safeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'Unknown preflight error';
  return message.replace(/https?:\/\/[^\s"'<>]+/g, '[redacted URL]');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      request: { type: 'string' },
      metadata: { type: 'string' },
      config: { type: 'string' },
      output: { type: 'string' },
    },
  });
  assert(
    values.request && values.metadata && values.config && values.output,
    'Required: --request request.json --metadata chains.json --config swapsxyz.json --output sample.json',
  );
  const request = SwapsXyzPreflightRequestSchema.parse(
    JSON.parse(await readFile(values.request, 'utf8')),
  );
  const chainMetadata = z
    .record(z.string(), ChainMetadataSchema)
    .parse(JSON.parse(await readFile(values.metadata, 'utf8')));
  assert(
    Object.values(chainMetadata).some(
      (chain) =>
        chain.protocol === ProtocolType.Sealevel &&
        chain.domainId === request.fromChain,
    ),
    'Preflight requires Sealevel source metadata',
  );
  const config = SwapsXyzBridgeConfigSchema.parse(
    JSON.parse(await readFile(values.config, 'utf8')),
  );
  const apiKey = process.env.SWAPSXYZ_API_KEY;
  assert(apiKey, 'SWAPSXYZ_API_KEY is required');
  const bridge = new SwapsXyzBridge(
    { ...config, apiKey, chainMetadata },
    pino({ level: 'silent' }),
  );
  const sample = await collectSwapsXyzPreflight(bridge, request).catch(
    (error: unknown) => {
      process.exitCode = 1;
      return {
        status: 'rejected',
        sampledAt: new Date().toISOString(),
        error: safeErrorMessage(error),
      };
    },
  );
  await writeFile(
    values.output,
    JSON.stringify(
      sample,
      (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    `Unsigned swaps.xyz preflight ${sample.status}; no approvals or transactions submitted.`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  main().catch((error: unknown) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}
