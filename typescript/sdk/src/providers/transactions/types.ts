import { ethers } from 'ethers';
import { z } from 'zod';

import { CallDataSchema, PopulatedTransactionSchema } from './schemas.js';

export type PopulatedTransaction = z.infer<typeof PopulatedTransactionSchema> &
  ethers.PopulatedTransaction;

export type CallData = z.infer<typeof CallDataSchema>;
