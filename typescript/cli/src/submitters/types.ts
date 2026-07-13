import { z } from 'zod';

import {
  type EvmIcaTxSubmitterProps,
  type EvmTimelockControllerSubmitterProps,
  type SubmitterMetadata,
  SubmitterMetadataSchema,
  TxSubmitterType,
  ZChainName,
  buildEvmIcaTxSubmitterPropsSchema,
  buildEvmTimelockControllerSubmitterPropsSchema,
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

// ICA / timelock submitters whose nested submitter may itself be any extended
// submitter, including the CLI-only `file` submitter. The SDK schemas restrict
// the nested submitter to SDK submitter types; the CLI registers a `file` factory
// at runtime (see deploy/warp.ts), so the strategy schema must permit it here.
// The wrapper field lists and zod suppressions live once in the SDK builders — the
// CLI only substitutes the nested submitter union (the Omit/intersection here is
// because TS recursion rules reject a generic alias in this recursive position).
type ExtendedIcaSubmitterMetadata = Omit<
  EvmIcaTxSubmitterProps,
  'internalSubmitter'
> & { internalSubmitter: ExtendedSubmitterMetadata };

type ExtendedTimelockSubmitterMetadata = Omit<
  EvmTimelockControllerSubmitterProps,
  'proposerSubmitter'
> & { proposerSubmitter: ExtendedSubmitterMetadata };

type ExtendedSubmitterMetadata =
  | SubmitterMetadata
  | FileSubmitterMetadata
  | ExtendedIcaSubmitterMetadata
  | ExtendedTimelockSubmitterMetadata;

// @ts-expect-error recursive schema causes type inference errors
const ExtendedSubmitterMetadataSchema: z.ZodSchema<ExtendedSubmitterMetadata> =
  z.lazy(() =>
    z.union([
      FileSubmitterMetadataSchema,
      ExtendedEvmIcaTxSubmitterPropsSchema,
      ExtendedEvmTimelockControllerSubmitterPropsSchema,
      SubmitterMetadataSchema,
    ]),
  );

const ExtendedEvmIcaTxSubmitterPropsSchema =
  buildEvmIcaTxSubmitterPropsSchema<ExtendedIcaSubmitterMetadata>(
    () => ExtendedSubmitterMetadataSchema,
  );

const ExtendedEvmTimelockControllerSubmitterPropsSchema =
  buildEvmTimelockControllerSubmitterPropsSchema<ExtendedTimelockSubmitterMetadata>(
    () => ExtendedSubmitterMetadataSchema,
  );

export const ExtendedSubmissionStrategySchema = z.object({
  submitter: ExtendedSubmitterMetadataSchema,
  feeSubmitter: ExtendedSubmitterMetadataSchema.optional(),
});

export type ExtendedSubmissionStrategy = z.infer<
  typeof ExtendedSubmissionStrategySchema
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// preprocessChainSubmissionStrategy rebuilds each entry as { submitter: ... } only,
// dropping feeSubmitter. Save and restore it so Zod sees the full extended shape.
// feeSubmitter is run through the same per-chain preprocessing so chain auto-fill
// and ICA/timelock defaults are applied consistently.
function preprocessExtendedChainSubmissionStrategy(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const feeSubmitters: Record<string, unknown> = {};
  for (const [chain, config] of Object.entries(value)) {
    if (isRecord(config) && config.feeSubmitter != null) {
      feeSubmitters[chain] = config.feeSubmitter;
    }
  }

  const preprocessed = preprocessChainSubmissionStrategy(value);

  if (!isRecord(preprocessed)) return preprocessed;

  for (const [chain, feeSubmitter] of Object.entries(feeSubmitters)) {
    if (!isRecord(preprocessed[chain])) continue;
    // Run feeSubmitter through the same chain-level preprocessing as submitter
    // (chain auto-fill, ICA/timelock defaults) by wrapping it as a submitter entry.
    const wrappedFee = preprocessChainSubmissionStrategy({
      [chain]: { submitter: feeSubmitter },
    });
    const processedFeeSubmitter =
      isRecord(wrappedFee) && isRecord(wrappedFee[chain])
        ? (wrappedFee[chain] as Record<string, unknown>).submitter
        : feeSubmitter;
    (preprocessed[chain] as Record<string, unknown>).feeSubmitter =
      processedFeeSubmitter;
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
