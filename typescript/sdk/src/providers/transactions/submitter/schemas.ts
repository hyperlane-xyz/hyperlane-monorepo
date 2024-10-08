import { z } from 'zod';

import { TxSubmitterType } from './TxSubmitterTypes.js';
import {
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
} from './ethersV5/schemas.js';

export const SubmitterMetadataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(TxSubmitterType.JSON_RPC),
  }),
  z.object({
    type: z.literal(TxSubmitterType.IMPERSONATED_ACCOUNT),
    ...EV5ImpersonatedAccountTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.GNOSIS_SAFE),
    ...EV5GnosisSafeTxSubmitterPropsSchema.shape,
  }),
]);
