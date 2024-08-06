import { ethers } from 'ethers';
import { z } from 'zod';

import {
  CallDataSchema,
  PopulatedTransactionSchema,
  PopulatedTransactionsSchema,
} from './schemas.js';

export type PopulatedTransaction = z.infer<typeof PopulatedTransactionSchema> &
  ethers.PopulatedTransaction;
export type PopulatedTransactions = z.infer<
  typeof PopulatedTransactionsSchema
> &
  ethers.PopulatedTransaction[];

export type CallData = z.infer<typeof CallDataSchema>;
