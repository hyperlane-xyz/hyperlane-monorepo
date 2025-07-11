import { z } from 'zod';

import {
  SubmissionStrategySchema,
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

export const EV5FileTxSubmitterPropsSchema = z.object({
  filepath: z.string(),
});

const FileSubmitterMetadataSchema = z.object({
  type: z.literal(CustomTxSubmitterType.FILE),
  ...EV5FileTxSubmitterPropsSchema.shape,
});

const ExtendedSubmitterMetadataSchema = SubmitterMetadataSchema.or(
  FileSubmitterMetadataSchema,
);

export const ExtendedSubmissionStrategySchema = SubmissionStrategySchema.extend(
  {
    submitter: ExtendedSubmitterMetadataSchema,
  },
);

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
