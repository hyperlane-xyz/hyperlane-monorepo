import { z } from 'zod';

import { AccountConfigSchema, GetCallRemoteSettingsSchema } from './schemas.js';

export type AccountConfig = z.infer<typeof AccountConfigSchema>;
/* For InterchainAccount::getCallRemote() */
export type GetCallRemoteSettings = z.infer<typeof GetCallRemoteSettingsSchema>;
