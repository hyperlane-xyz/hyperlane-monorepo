import { GetCallRemoteSettingsSchema } from '../../../../middleware/account/schemas.js';

export const EV5InterchainAccountTxTransformerPropsSchema =
  GetCallRemoteSettingsSchema.pick({
    chain: true,
    config: true,
    hookMetadata: true,
  });
