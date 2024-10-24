import { z } from 'zod';

import { CallDataSchema } from './schemas.js';

export type CallData = z.infer<typeof CallDataSchema>;
