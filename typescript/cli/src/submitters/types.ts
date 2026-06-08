import { z } from 'zod';

import {
  type SubmitterMetadata,
  SubmitterMetadataSchema,
  TxSubmitterType,
  ZChainName,
  preprocessChainSubmissionStrategy,
  refineChainSubmissionStrategy,
} from '@hyperlane-xyz/sdk';

export const CustomTxSubmitterType = {
  ...TxSubmitterType,
  FILE: 'file',
} as const;

export const FileTxSubmitterPropsSchema = z.object({
  filepath: z.string(),
  chain: ZChainName,
});

const FileSubmitterMetadataSchema = z.object({
  type: z.literal(CustomTxSubmitterType.FILE),
  ...FileTxSubmitterPropsSchema.shape,
});

type FileSubmitterMetadata = z.infer<typeof FileSubmitterMetadataSchema>;

type ExtendedSubmitterMetadata = SubmitterMetadata | FileSubmitterMetadata;

// @ts-expect-error recursive schema causes type inference errors
const ExtendedSubmitterMetadataSchema: z.ZodSchema<ExtendedSubmitterMetadata> =
  SubmitterMetadataSchema.or(FileSubmitterMetadataSchema);

export const ExtendedSubmissionStrategySchema = z.object({
  submitter: ExtendedSubmitterMetadataSchema,
  feeSubmitter: ExtendedSubmitterMetadataSchema.optional(),
});

export type ExtendedSubmissionStrategy = z.infer<
  typeof ExtendedSubmissionStrategySchema
>;

// preprocessChainSubmissionStrategy rebuilds each entry as { submitter: ... } only,
// dropping feeSubmitter. Save and restore it so Zod sees the full extended shape.
function preprocessExtendedChainSubmissionStrategy(value: unknown): unknown {
  const raw = value as Record<string, any>;
  const feeSubmitters: Record<string, unknown> = {};
  for (const [chain, config] of Object.entries(raw)) {
    if (config?.feeSubmitter != null) {
      feeSubmitters[chain] = config.feeSubmitter;
    }
  }
  const preprocessed = preprocessChainSubmissionStrategy(raw) as Record<
    string,
    any
  >;
  for (const [chain, feeSubmitter] of Object.entries(feeSubmitters)) {
    if (preprocessed[chain]) {
      preprocessed[chain].feeSubmitter = feeSubmitter;
    }
  }
  return preprocessed;
}

export const ExtendedChainSubmissionStrategySchema = z.preprocess(
  preprocessExtendedChainSubmissionStrategy,
  z
    .record(ZChainName, ExtendedSubmissionStrategySchema)
    .superRefine(refineChainSubmissionStrategy),
);

export type ExtendedChainSubmissionStrategy = z.infer<
  typeof ExtendedChainSubmissionStrategySchema
>;

export type FileTxSubmitterProps = z.infer<typeof FileTxSubmitterPropsSchema>;
