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

export const ExtendedSubmissionStrategySchema: z.ZodSchema<{
  submitter: ExtendedSubmitterMetadata;
  submitterOverrides?: Record<string, ExtendedSubmitterMetadata>;
}> = z.object({
  submitter: ExtendedSubmitterMetadataSchema,
  submitterOverrides: z.record(z.string(), ExtendedSubmitterMetadataSchema).optional(),
});

export type ExtendedSubmissionStrategy = z.infer<
  typeof ExtendedSubmissionStrategySchema
>;

function getOwnObjectField(value: unknown, field: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }

  try {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  try {
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function cloneOwnEnumerableObject(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }

  let keys: string[];
  try {
    keys = Object.keys(value as Record<string, unknown>);
  } catch {
    return null;
  }

  const clonedObject = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    clonedObject[key] = getOwnObjectField(value, key);
  }

  return clonedObject;
}

function preprocessExtendedChainSubmissionStrategy(value: unknown) {
  const raw =
    (cloneOwnEnumerableObject(value) as Record<string, any> | null) ??
    (Object.create(null) as Record<string, any>);
  const preprocessedBase = preprocessChainSubmissionStrategy(raw as any) as Record<
    string,
    { submitter: SubmitterMetadata }
  >;

  const result = Object.create(null) as Record<string, any>;
  for (const [chain, strategy] of Object.entries(raw)) {
    const ownSubmitter = getOwnObjectField(strategy, 'submitter');
    const submitterOverrides = getOwnObjectField(
      strategy,
      'submitterOverrides',
    ) as
      | Record<string, SubmitterMetadata>
      | undefined;
    const preprocessedChainStrategy = getOwnObjectField(preprocessedBase, chain) as
      | { submitter: SubmitterMetadata }
      | undefined;
    const preprocessedSubmitter =
      ownSubmitter !== undefined
        ? preprocessedChainStrategy?.submitter
        : undefined;

    let preprocessedOverrides: Record<string, SubmitterMetadata> | undefined;
    if (submitterOverrides) {
      preprocessedOverrides = Object.fromEntries(
        Object.entries(submitterOverrides).map(([target, submitter]) => [
          target,
          (
            preprocessChainSubmissionStrategy({
              [chain]: {
                submitter,
              },
            } as any) as Record<string, { submitter: SubmitterMetadata }>
          )[chain].submitter,
        ]),
      );
    }

    result[chain] = {
      submitter: preprocessedSubmitter ?? ownSubmitter,
      ...(preprocessedOverrides
        ? { submitterOverrides: preprocessedOverrides }
        : {}),
    };
  }

  return result;
}

function refineExtendedChainSubmissionStrategy(
  value: Record<string, { submitter: ExtendedSubmitterMetadata; submitterOverrides?: Record<string, ExtendedSubmitterMetadata> }>,
  ctx: z.RefinementCtx,
) {
  refineChainSubmissionStrategy(value as any, ctx);

  Object.entries(value).forEach(([chain, strategy]) => {
    const overrides = strategy.submitterOverrides;
    if (!overrides) {
      return;
    }

    Object.values(overrides).forEach((overrideSubmitter) => {
      refineChainSubmissionStrategy(
        {
          [chain]: {
            submitter: overrideSubmitter,
          },
        } as any,
        ctx,
      );
    });
  });
}

export const ExtendedChainSubmissionStrategySchema = z.preprocess(
  preprocessExtendedChainSubmissionStrategy,
  z
    .record(ZChainName, ExtendedSubmissionStrategySchema)
    .superRefine(refineExtendedChainSubmissionStrategy),
);

export type ExtendedChainSubmissionStrategy = z.infer<
  typeof ExtendedChainSubmissionStrategySchema
>;

export type FileTxSubmitterProps = z.infer<typeof FileTxSubmitterPropsSchema>;
