import { z } from 'zod';

import { ZChainName } from '../metadata/customZodTypes.js';
import { TxSubmitterType } from '../providers/transactions/submitter/TxSubmitterTypes.js';
import {
  preprocessChainSubmissionStrategy,
  refineChainSubmissionStrategy,
} from '../providers/transactions/submitter/builder/types.js';
import {
  SubmitterMetadata,
  SubmitterMetadataSchema,
} from '../providers/transactions/submitter/types.js';

export const CustomTxSubmitterType = {
  ...TxSubmitterType,
  FILE: 'file',
} as const;

export const EV5FileTxSubmitterPropsSchema = z.object({
  filepath: z.string(),
});

const FileSubmitterMetadataSchema = z.object({
  type: z.literal(CustomTxSubmitterType.FILE),
  ...EV5FileTxSubmitterPropsSchema.shape,
});

type FileSubmitterMetadata = z.infer<typeof FileSubmitterMetadataSchema>;

type ExtendedSubmitterMetadata = SubmitterMetadata | FileSubmitterMetadata;

// @ts-expect-error recursive schema causes type inference errors
const ExtendedSubmitterMetadataSchema: z.ZodSchema<ExtendedSubmitterMetadata> =
  SubmitterMetadataSchema.or(FileSubmitterMetadataSchema);

export const ExtendedSubmissionStrategySchema: z.ZodSchema<{
  submitter: ExtendedSubmitterMetadata;
}> = z.object({
  submitter: ExtendedSubmitterMetadataSchema,
});

export type ExtendedSubmissionStrategy = z.infer<
  typeof ExtendedSubmissionStrategySchema
>;

export const ExtendedChainSubmissionStrategySchema = z.preprocess(
  preprocessChainSubmissionStrategy,
  z
    .record(ZChainName, ExtendedSubmissionStrategySchema)
    .superRefine(refineChainSubmissionStrategy),
);

export type ExtendedChainSubmissionStrategy = z.infer<
  typeof ExtendedChainSubmissionStrategySchema
>;

export type EV5FileTxSubmitterProps = z.infer<
  typeof EV5FileTxSubmitterPropsSchema
>;
