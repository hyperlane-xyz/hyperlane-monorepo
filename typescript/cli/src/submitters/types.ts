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

function preprocessExtendedChainSubmissionStrategy(
  value: unknown,
): Record<string, ExtendedSubmissionStrategy> {
  const strategies = value as Record<string, ExtendedSubmissionStrategy>;

  return Object.fromEntries(
    Object.entries(strategies).map(([chain, strategy]) => {
      const submitter = strategy.submitter;
      if (submitter.type === 'submitter_ref') {
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

      const processed = preprocessChainSubmissionStrategy<{
        submitter: SubmitterMetadata;
      }>({
        [chain]: { submitter },
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
          submitter.type !== 'submitter_ref' &&
          submitter.type !== CustomTxSubmitterType.FILE
        );
      })
      .map(([chain, strategy]) => [
        chain,
        { submitter: strategy.submitter as SubmitterMetadata },
      ]),
  );

  refineChainSubmissionStrategy(standardStrategies, ctx);
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
