import { z } from 'zod';

import { CheckpointStorageConfigSchema } from './schemas.js';

export type CheckpointStorageConfig = z.infer<
  typeof CheckpointStorageConfigSchema
>;
