import { ethers } from 'ethers';
import { z } from 'zod';

import { PopulatedTransactionSchema } from './schemas.js';

export type PopulatedTransaction = z.infer<typeof PopulatedTransactionSchema> &
  ethers.PopulatedTransaction;
