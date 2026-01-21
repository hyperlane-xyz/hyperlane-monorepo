import { z } from 'zod';

import { ZChainName, ZHash, ZUWei } from '../../metadata/customZodTypes.js';
import { CallDataSchema } from '../../providers/transactions/types.js';

export const AccountConfigSchema = z.object({
  origin: ZChainName,
  owner: ZHash,
  localRouter: ZHash.optional(),
  routerOverride: ZHash.optional(),
  ismOverride: ZHash.optional(),
});

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export const StandardHookMetadataSchema = z.object({
  msgValue: ZUWei.optional(),
  gasLimit: ZUWei.optional(),
  refundAddress: z.string().optional(),
});

export type StandardHookMetadata = z.infer<typeof StandardHookMetadataSchema>;

/* For InterchainAccount::getCallRemote() */
export const GetCallRemoteSettingsSchema = z.object({
  chain: ZChainName,
  destination: ZChainName,
  innerCalls: z.array(CallDataSchema),
  config: AccountConfigSchema,
  hookMetadata: z.union([z.string(), StandardHookMetadataSchema]).optional(),
});
/* For InterchainAccount::getCallRemote() */

export type GetCallRemoteSettings = z.infer<typeof GetCallRemoteSettingsSchema>;
