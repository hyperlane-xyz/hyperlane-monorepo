import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { assert } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../types.js';
import {
  SubmissionStrategy,
  SubmissionStrategySchema,
} from './builder/types.js';
import {
  SubmitterMetadata,
  SubmitterMetadataSchema,
  UnresolvedSubmitterReference,
  UnresolvedSubmitterReferenceSchema,
} from './types.js';
import { TxSubmitterType } from './TxSubmitterTypes.js';

export interface SubmitterLookup {
  getSubmitter(ref: string): unknown;
}

export const UnresolvedSubmissionStrategySchema = z
  .object({
    submitter: z.union([
      SubmitterMetadataSchema,
      UnresolvedSubmitterReferenceSchema,
    ]),
  })
  .strict();

export type UnresolvedSubmissionStrategy = z.infer<
  typeof UnresolvedSubmissionStrategySchema
>;

function isUnresolvedSubmitterReference(
  value: SubmitterMetadata | UnresolvedSubmitterReference,
): value is UnresolvedSubmitterReference {
  return value.type === TxSubmitterType.SUBMITTER_REF;
}

function parseResolvedSubmitterPayload(
  payload: unknown,
  ref: string,
): SubmitterMetadata {
  const strategyResult = SubmissionStrategySchema.safeParse(payload);
  if (strategyResult.success) {
    return strategyResult.data.submitter;
  }

  const metadataResult = SubmitterMetadataSchema.safeParse(payload);
  if (metadataResult.success) {
    return metadataResult.data;
  }

  throw new Error(
    `Submitter reference ${ref} did not resolve to SubmitterMetadata or SubmissionStrategy`,
  );
}

export async function resolveSubmitterMetadata(
  submitter:
    | SubmitterMetadata
    | UnresolvedSubmitterReference
    | Promise<SubmitterMetadata | UnresolvedSubmitterReference>,
  lookup?: SubmitterLookup,
): Promise<SubmitterMetadata> {
  const awaitedSubmitter = await submitter;
  if (!isUnresolvedSubmitterReference(awaitedSubmitter)) {
    return awaitedSubmitter;
  }

  assert(
    lookup,
    `Submitter reference ${awaitedSubmitter.ref} requires a submitter lookup`,
  );

  const payload = await lookup.getSubmitter(awaitedSubmitter.ref);
  assert(payload, `Submitter reference ${awaitedSubmitter.ref} was not found`);
  return parseResolvedSubmitterPayload(payload, awaitedSubmitter.ref);
}

export async function resolveSubmissionStrategy(
  strategy:
    | UnresolvedSubmissionStrategy
    | SubmissionStrategy
    | Promise<UnresolvedSubmissionStrategy | SubmissionStrategy>,
  lookup?: SubmitterLookup,
  expectedChain?: ChainName,
): Promise<SubmissionStrategy> {
  const awaitedStrategy = await strategy;
  const shouldAssertChain =
    expectedChain && isUnresolvedSubmitterReference(awaitedStrategy.submitter);
  const submitter = await resolveSubmitterMetadata(
    awaitedStrategy.submitter,
    lookup,
  );
  assert(
    !shouldAssertChain || submitter.chain === expectedChain,
    `Submitter reference resolved to chain ${submitter.chain}, expected ${expectedChain}`,
  );
  return {
    ...awaitedStrategy,
    submitter,
  };
}

export function parseSubmitterReferencePayload(
  payload: string,
  source: string,
): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    try {
      return parseYaml(payload);
    } catch (error) {
      throw new Error(
        `Failed to parse submitter reference payload from ${source}: ${String(error)}`,
      );
    }
  }
}
