import { z } from 'zod';

import { ZChainName, ZHash } from '../../metadata/customZodTypes.js';

export const AccountConfigSchema = z.object({
  origin: ZChainName,
  owner: ZHash,
  localRouter: ZHash.optional(),
  routerOverride: ZHash.optional(),
  ismOverride: ZHash.optional(),
});
