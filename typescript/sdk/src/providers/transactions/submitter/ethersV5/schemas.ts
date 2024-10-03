import { z } from 'zod';

import { ZChainName, ZHash } from '../../../../metadata/customZodTypes.js';

export const EV5GnosisSafeTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
  safeAddress: ZHash,
});

export const EV5GnosisSafeTxBuilderPropsSchema = z.object({
  version: z.string(),
  chain: ZChainName,
  meta: z.object({}), // TODO: Figure out what the actual schema for this is. For now, it's unused.
  safeAddress: ZHash,
});

export const EV5ImpersonatedAccountTxSubmitterPropsSchema = z.object({
  userAddress: ZHash,
});
