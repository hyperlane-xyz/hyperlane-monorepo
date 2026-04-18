import { z } from 'zod';

import {
  type SubmitterMetadata,
  SubmitterMetadataSchema,
  TxSubmitterType,
  UnresolvedSubmitterReferenceSchema,
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

type ExtendedSubmitterMetadata =
  | SubmitterMetadata
  | z.output<typeof FileSubmitterMetadataSchema>
  | z.output<typeof UnresolvedSubmitterReferenceSchema>;

const ExtendedSubmitterMetadataSchema: z.ZodType<
  ExtendedSubmitterMetadata,
  z.ZodTypeDef,
  unknown
> = z.union([
  SubmitterMetadataSchema,
  FileSubmitterMetadataSchema,
  UnresolvedSubmitterReferenceSchema,
]);

export type ExtendedSubmissionStrategy = {
  submitter: ExtendedSubmitterMetadata;
};

export const ExtendedSubmissionStrategySchema: z.ZodType<
  ExtendedSubmissionStrategy,
  z.ZodTypeDef,
  unknown
> = z.object({
  submitter: ExtendedSubmitterMetadataSchema,
});

function preprocessExtendedChainSubmissionStrategy(value: unknown): unknown {
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([chain, strategy]) => {
      if (!isRecord(strategy) || !isRecord(strategy.submitter)) {
        return [chain, strategy];
      }

      const submitter = strategy.submitter;
      if (submitter.type === TxSubmitterType.SUBMITTER_REF) {
        return [chain, strategy];
      }

      if (submitter.type === CustomTxSubmitterType.FILE) {
        return [
          chain,
          {
            submitter: {
              ...submitter,
              chain: submitter.chain ?? chain,
            },
          },
        ];
      }

      if (typeof submitter.type !== 'string') {
        return [chain, strategy];
      }

      const typedSubmitter = { ...submitter, type: submitter.type };
      const processed = preprocessChainSubmissionStrategy<{
        submitter: { type: string };
      }>({
        [chain]: { submitter: typedSubmitter },
      });
      return [chain, processed[chain]];
    }),
  );
}

function refineExtendedChainSubmissionStrategy(
  value: Record<string, ExtendedSubmissionStrategy>,
  ctx: z.RefinementCtx,
) {
  const standardStrategies = Object.fromEntries(
    Object.entries(value)
      .filter(([, strategy]) => {
        const submitter = strategy.submitter;
        return (
          submitter.type !== TxSubmitterType.SUBMITTER_REF &&
          submitter.type !== CustomTxSubmitterType.FILE
        );
      })
      .map(([chain, strategy]) => {
        return [
          chain,
          { submitter: SubmitterMetadataSchema.parse(strategy.submitter) },
        ];
      }),
  );

  refineChainSubmissionStrategy(standardStrategies, ctx);

  for (const [chain, strategy] of Object.entries(value)) {
    const { submitter } = strategy;
    if (
      submitter.type === CustomTxSubmitterType.FILE &&
      submitter.chain !== chain
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `File submitter chain ${submitter.chain} must match strategy chain ${chain}`,
        path: [chain, 'submitter', 'chain'],
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const ExtendedChainSubmissionStrategySchema: z.ZodType<
  Record<string, ExtendedSubmissionStrategy>,
  z.ZodTypeDef,
  unknown
> = z.preprocess(
  preprocessExtendedChainSubmissionStrategy,
  z
    .record(ZChainName, ExtendedSubmissionStrategySchema)
    .superRefine(refineExtendedChainSubmissionStrategy),
);

export type ExtendedChainSubmissionStrategy = z.infer<
  typeof ExtendedChainSubmissionStrategySchema
>;

export type FileTxSubmitterProps = z.infer<typeof FileTxSubmitterPropsSchema>;
