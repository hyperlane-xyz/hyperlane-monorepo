import { z } from 'zod';

import { EV5InterchainAccountTxTransformerPropsSchema } from './schemas.js';

export type EV5InterchainAccountTxTransformerProps = z.infer<
  typeof EV5InterchainAccountTxTransformerPropsSchema
>;
