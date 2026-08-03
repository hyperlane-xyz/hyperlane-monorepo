import { z } from 'zod';

export const PrintableSvmTransactionSchema = z.object({
  annotation: z.string().optional(),
  instructions: z.array(z.unknown()).optional(),
  computeUnits: z.number().optional(),
  transaction_base58: z.string(),
  message_base58: z.string().optional(),
  waitForSlotAdvance: z.boolean().optional(),
});
export type SvmForkTransaction = z.infer<typeof PrintableSvmTransactionSchema>;

export const SvmRawForkConfigSchema = z.union([
  z.object({ transactions: z.array(PrintableSvmTransactionSchema) }),
  z.object({ path: z.string() }),
]);
export type SvmRawForkConfig = z.infer<typeof SvmRawForkConfigSchema>;

export interface SvmForkConfig {
  transactions: SvmForkTransaction[];
}

/**
 * Parses a per-chain SVM fork-config slice. A `path` reference loads the
 * `warp apply --submitter file` output (a `PrintableSvmTransaction[]`) via the
 * injected file reader; inline `transactions` are used directly.
 */
export function parseSvmForkConfig(
  raw: unknown,
  fileReader: <T>(path: string) => T,
): SvmForkConfig {
  const parsed = SvmRawForkConfigSchema.parse(raw);

  if ('path' in parsed) {
    const transactions = z
      .array(PrintableSvmTransactionSchema)
      .parse(fileReader(parsed.path));
    return { transactions };
  }

  return { transactions: parsed.transactions };
}
