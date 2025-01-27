import { z } from 'zod';

import { ZChainName, ZHash } from '../../metadata/customZodTypes.js';
import {
  BigNumberSchema,
  CallDataSchema,
} from '../../providers/transactions/types.js';

export const AccountConfigSchema = z.object({
  origin: ZChainName,
  owner: ZHash,
  localRouter: ZHash.optional(),
  routerOverride: ZHash.optional(),
  ismOverride: ZHash.optional(),
});

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

/* For InterchainAccount::getCallRemote() */
export const GetCallRemoteSettingsSchema = z.object({
  chain: ZChainName,
  destination: ZChainName,
  innerCalls: z.array(CallDataSchema),
  config: AccountConfigSchema,
  hookMetadata: BigNumberSchema.optional(),
});
/* For InterchainAccount::getCallRemote() */

export type GetCallRemoteSettings = z.infer<typeof GetCallRemoteSettingsSchema>;
