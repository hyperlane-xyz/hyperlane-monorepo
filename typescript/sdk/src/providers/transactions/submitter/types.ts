import { z } from 'zod';

import { EvmSubmitterMetadataSchema } from './ethersV5/types.js';

export const SubmitterMetadataSchema = EvmSubmitterMetadataSchema;
export type SubmitterMetadata = z.infer<typeof EvmSubmitterMetadataSchema>;
