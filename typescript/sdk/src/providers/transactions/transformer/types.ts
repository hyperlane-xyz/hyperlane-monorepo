import { z } from 'zod';

import { TransformerMetadataSchema } from './schemas.js';

export type TransformerMetadata = z.infer<typeof TransformerMetadataSchema>;
