import { z } from 'zod';

import { ZChainName, ZHash } from '../../../../metadata/customZodTypes.js';

export const EV5GnosisSafeTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
  safeAddress: ZHash,
});

export const EV5GnosisSafeTxBuilderPropsSchema = z.object({
  version: z.string(),
  chain: ZChainName,
  meta: z.object({}),
  safeAddress: ZHash,
});

export const EV5ImpersonatedAccountTxSubmitterPropsSchema = z.object({
  userAddress: ZHash,
});
