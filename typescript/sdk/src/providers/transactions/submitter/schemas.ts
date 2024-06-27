import { z } from 'zod';

import { TxSubmitterType } from './TxSubmitterTypes.js';
import {
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
} from './ethersV5/schemas.js';

export const SubmitterMetadataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(TxSubmitterType.JSON_RPC),
    props: z.object({}).optional(),
  }),
  z.object({
    type: z.literal(TxSubmitterType.IMPERSONATED_ACCOUNT),
    props: EV5ImpersonatedAccountTxSubmitterPropsSchema,
  }),
  z.object({
    type: z.literal(TxSubmitterType.GNOSIS_SAFE),
    props: EV5GnosisSafeTxSubmitterPropsSchema,
  }),
]);
