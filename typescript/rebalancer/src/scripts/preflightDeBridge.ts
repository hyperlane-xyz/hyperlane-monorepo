import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { pino } from 'pino';
import { z } from 'zod';

import { ChainMetadataSchema } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { DeBridgeBridge } from '../bridges/DeBridgeBridge.js';

const requestSchema = z.object({
  fromChain: z.number().int().positive(),
  toChain: z.number().int().positive(),
  fromToken: z.string(),
  toToken: z.string(),
  fromAddress: z.string(),
  toAddress: z.string(),
  fromAmount: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(BigInt),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      request: { type: 'string' },
      metadata: { type: 'string' },
      output: { type: 'string' },
      'max-fee-percent': { type: 'string' },
    },
  });
  assert(
    values.request &&
      values.metadata &&
      values.output &&
      values['max-fee-percent'],
    'Required: --request request.json --metadata chains.json --output unsigned.json --max-fee-percent <configured limit>',
  );
  const request = requestSchema.parse(
    JSON.parse(await readFile(values.request, 'utf8')),
  );
  const chainMetadata = z
    .record(z.string(), ChainMetadataSchema)
    .parse(JSON.parse(await readFile(values.metadata, 'utf8')));
  const bridge = new DeBridgeBridge(
    { chainMetadata, maxFeePercent: Number(values['max-fee-percent']) },
    pino({ level: 'silent' }),
  );
  const quote = await bridge.quote(request);
  const prepared = await bridge.prepare(quote);
  // Metadata may contain credentialed RPC URLs; never include it in artifacts.
  await writeFile(
    values.output,
    JSON.stringify(
      { quote, ...prepared },
      (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    `Validated unsigned order ${prepared.response.orderId}; no approvals or transactions submitted.`,
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown preflight error';
  console.error(message.replace(/https?:\/\/[^\s"'<>]+/g, '[redacted URL]'));
  process.exitCode = 1;
});
