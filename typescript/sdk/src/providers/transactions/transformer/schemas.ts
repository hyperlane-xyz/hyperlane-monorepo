import { z } from 'zod';

import { TxTransformerType } from './TxTransformerTypes.js';
import { EV5InterchainAccountTxTransformerPropsSchema } from './ethersV5/schemas.js';

export const TransformerMetadataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(TxTransformerType.INTERCHAIN_ACCOUNT),
    ...EV5InterchainAccountTxTransformerPropsSchema.shape,
  }),
]);
