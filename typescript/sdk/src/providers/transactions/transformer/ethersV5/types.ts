import { z } from 'zod';

import { GetCallRemoteSettingsSchema } from '../../../../middleware/account/types.js';

export const EV5InterchainAccountTxTransformerPropsSchema =
  GetCallRemoteSettingsSchema.pick({
    chain: true,
    config: true,
    hookMetadata: true,
  });

export type EV5InterchainAccountTxTransformerProps = z.infer<
  typeof EV5InterchainAccountTxTransformerPropsSchema
>;
