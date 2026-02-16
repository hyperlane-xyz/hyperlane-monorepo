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

function hasOwnObjectField(value: unknown, field: string): boolean {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  try {
    return Object.prototype.hasOwnProperty.call(value, field);
  } catch {
    return false;
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
  let preprocessedBase = Object.create(null) as Record<
    string,
    { submitter: SubmitterMetadata }
  >;
  try {
    preprocessedBase = preprocessChainSubmissionStrategy(raw as any) as Record<
      string,
      { submitter: SubmitterMetadata }
    >;
  } catch {
    preprocessedBase = Object.create(null) as Record<
      string,
      { submitter: SubmitterMetadata }
    >;
  }

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
      let overrideTargets: string[] = [];
      try {
        overrideTargets = Object.keys(submitterOverrides);
      } catch {
        overrideTargets = [];
      }

      const normalizedOverrides = Object.create(null) as Record<
        string,
        SubmitterMetadata
      >;

      for (const target of overrideTargets) {
        const overrideSubmitter = getOwnObjectField(submitterOverrides, target);
        if (overrideSubmitter === undefined) {
          continue;
        }

        try {
          const preprocessedOverride = preprocessChainSubmissionStrategy({
            [chain]: {
              submitter: overrideSubmitter,
            },
          } as any) as Record<string, { submitter: SubmitterMetadata }>;
          const preprocessedOverrideChain = getOwnObjectField(
            preprocessedOverride,
            chain,
          ) as { submitter: SubmitterMetadata } | undefined;
          if (preprocessedOverrideChain?.submitter) {
            normalizedOverrides[target] = preprocessedOverrideChain.submitter;
          }
        } catch {
          continue;
        }
      }

      if (Object.keys(normalizedOverrides).length > 0) {
        preprocessedOverrides = normalizedOverrides;
      }
    }

    const normalizedStrategy = Object.create(null) as Record<string, unknown>;
    normalizedStrategy.submitter = preprocessedSubmitter ?? ownSubmitter;
    if (preprocessedOverrides) {
      normalizedStrategy.submitterOverrides = preprocessedOverrides;
    }
    result[chain] = normalizedStrategy;
  }

  return result;
}

function refineExtendedChainSubmissionStrategy(
  value: Record<string, { submitter: ExtendedSubmitterMetadata; submitterOverrides?: Record<string, ExtendedSubmitterMetadata> }>,
  ctx: z.RefinementCtx,
) {
  refineChainSubmissionStrategy(value as any, ctx);

  Object.entries(value).forEach(([chain, strategy]) => {
    const overrides = getOwnObjectField(
      strategy,
      'submitterOverrides',
    ) as Record<string, ExtendedSubmitterMetadata> | undefined;
    if (
      !overrides ||
      (typeof overrides !== 'object' && typeof overrides !== 'function')
    ) {
      return;
    }

    let overrideKeys: string[] = [];
    try {
      overrideKeys = Object.keys(overrides);
    } catch {
      overrideKeys = [];
    }

    overrideKeys.forEach((overrideKey) => {
      const overrideSubmitter = getOwnObjectField(
        overrides,
        overrideKey,
      ) as ExtendedSubmitterMetadata | undefined;
      if (!overrideSubmitter) {
        return;
      }

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

function shouldTemporarilyRemovePrototypeField(
  descriptor: PropertyDescriptor | undefined,
): boolean {
  if (!descriptor || !descriptor.configurable) {
    return false;
  }

  if ('writable' in descriptor) {
    return descriptor.writable === false;
  }

  return typeof descriptor.set !== 'function';
}

function withTemporarilyRemovedPrototypeFields<T>(callback: () => T): T {
  let prototypeFields: string[] = [];
  try {
    prototypeFields = Object.getOwnPropertyNames(Object.prototype);
  } catch {
    prototypeFields = [];
  }

  const removedDescriptors: Array<{
    field: string;
    descriptor: PropertyDescriptor;
  }> = [];

  for (const field of prototypeFields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(Object.prototype, field);
    } catch {
      continue;
    }

    if (!shouldTemporarilyRemovePrototypeField(descriptor)) {
      continue;
    }

    try {
      if (delete (Object.prototype as Record<string, unknown>)[field]) {
        removedDescriptors.push({ field, descriptor });
      }
    } catch {
      continue;
    }
  }

  try {
    return callback();
  } finally {
    for (let i = removedDescriptors.length - 1; i >= 0; i -= 1) {
      const { field, descriptor } = removedDescriptors[i];
      Object.defineProperty(Object.prototype, field, descriptor);
    }
  }
}

export function parseExtendedSubmissionStrategy(
  value: unknown,
): ExtendedSubmissionStrategy {
  const parsedStrategy = withTemporarilyRemovedPrototypeFields(() =>
    ExtendedSubmissionStrategySchema.parse(value),
  );
  return sanitizeExtendedSubmissionStrategyOutput(parsedStrategy, value);
}

export function parseExtendedChainSubmissionStrategy(
  value: unknown,
): ExtendedChainSubmissionStrategy {
  const parsedStrategy = withTemporarilyRemovedPrototypeFields(() =>
    ExtendedChainSubmissionStrategySchema.parse(value),
  );
  return sanitizeExtendedChainSubmissionStrategyOutput(parsedStrategy, value);
}

function sanitizeExtendedSubmissionStrategyOutput(
  value: ExtendedSubmissionStrategy,
  rawValue?: unknown,
): ExtendedSubmissionStrategy {
  const sanitizedStrategy = Object.create(null) as Record<string, unknown>;
  const submitter = getOwnObjectField(value, 'submitter');
  sanitizedStrategy.submitter =
    cloneOwnEnumerableObject(submitter) ?? submitter;

  const submitterOverrides = getOwnObjectField(
    value,
    'submitterOverrides',
  ) as Record<string, unknown> | undefined;
  const shouldIncludeSubmitterOverrides = hasOwnObjectField(
    rawValue ?? value,
    'submitterOverrides',
  );
  if (
    shouldIncludeSubmitterOverrides &&
    submitterOverrides &&
    (typeof submitterOverrides === 'object' ||
      typeof submitterOverrides === 'function')
  ) {
    const sanitizedOverrides =
      cloneOwnEnumerableObject(submitterOverrides) ??
      (Object.create(null) as Record<string, unknown>);
    for (const overrideKey of Object.keys(sanitizedOverrides)) {
      const overrideSubmitter = getOwnObjectField(
        sanitizedOverrides,
        overrideKey,
      );
      sanitizedOverrides[overrideKey] =
        cloneOwnEnumerableObject(overrideSubmitter) ?? overrideSubmitter;
    }
    sanitizedStrategy.submitterOverrides = sanitizedOverrides;
  }

  return sanitizedStrategy as ExtendedSubmissionStrategy;
}

function sanitizeExtendedChainSubmissionStrategyOutput(
  value: ExtendedChainSubmissionStrategy,
  rawValue?: unknown,
): ExtendedChainSubmissionStrategy {
  const sanitizedStrategy = Object.create(null) as Record<string, unknown>;

  for (const chainKey of Object.keys(value)) {
    const chainStrategy = getOwnObjectField(value, chainKey);
    const rawChainStrategy = getOwnObjectField(rawValue, chainKey);
    if (
      chainStrategy &&
      (typeof chainStrategy === 'object' || typeof chainStrategy === 'function')
    ) {
      sanitizedStrategy[chainKey] = sanitizeExtendedSubmissionStrategyOutput(
        chainStrategy as ExtendedSubmissionStrategy,
        rawChainStrategy,
      );
      continue;
    }
    sanitizedStrategy[chainKey] = chainStrategy;
  }

  return sanitizedStrategy as ExtendedChainSubmissionStrategy;
}

export type FileTxSubmitterProps = z.infer<typeof FileTxSubmitterPropsSchema>;
