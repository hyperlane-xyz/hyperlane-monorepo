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
  GCP_KMS: 'gcpKms',
} as const;

export const FileTxSubmitterPropsSchema = z.object({
  filepath: z.string(),
  chain: ZChainName,
});

const FileSubmitterMetadataSchema = z.object({
  type: z.literal(CustomTxSubmitterType.FILE),
  ...FileTxSubmitterPropsSchema.shape,
});

export const GcpKmsSubmitterPropsSchema = z.object({
  keyId: z.string(),
  chain: ZChainName,
});

const GcpKmsSubmitterMetadataSchema = z.object({
  type: z.literal(CustomTxSubmitterType.GCP_KMS),
  ...GcpKmsSubmitterPropsSchema.shape,
});

export type GcpKmsSubmitterProps = z.infer<typeof GcpKmsSubmitterPropsSchema>;

type FileSubmitterMetadata = z.infer<typeof FileSubmitterMetadataSchema>;
type GcpKmsSubmitterMetadata = z.infer<typeof GcpKmsSubmitterMetadataSchema>;

type ExtendedSubmitterMetadata =
  | SubmitterMetadata
  | FileSubmitterMetadata
  | GcpKmsSubmitterMetadata;

// @ts-expect-error recursive schema causes type inference errors
const ExtendedSubmitterMetadataSchema: z.ZodSchema<ExtendedSubmitterMetadata> =
  SubmitterMetadataSchema.or(FileSubmitterMetadataSchema).or(
    GcpKmsSubmitterMetadataSchema,
  );

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

export type FileTxSubmitterProps = z.infer<typeof FileTxSubmitterPropsSchema>;
