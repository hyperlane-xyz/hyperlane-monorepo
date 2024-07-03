import { z } from 'zod';

import { SubmitterMetadataSchema } from './schemas.js';

export type SubmitterMetadata = z.infer<typeof SubmitterMetadataSchema>;
