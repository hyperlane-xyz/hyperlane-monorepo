import { z } from 'zod';

import { TxSubmitterType } from './TxSubmitterTypes.js';
import {
  EV5GnosisSafeTxBuilderPropsSchema,
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
  EV5JsonRpcTxSubmitterPropsSchema,
} from './ethersV5/types.js';

export const SubmitterMetadataSchema = z.discriminatedUnion('type', [
  EV5JsonRpcTxSubmitterPropsSchema.extend({
    type: z.literal(TxSubmitterType.JSON_RPC),
  }),
  EV5ImpersonatedAccountTxSubmitterPropsSchema.extend({
    type: z.literal(TxSubmitterType.IMPERSONATED_ACCOUNT),
  }),
  EV5GnosisSafeTxSubmitterPropsSchema.extend({
    type: z.literal(TxSubmitterType.GNOSIS_SAFE),
  }),
  EV5GnosisSafeTxBuilderPropsSchema.extend({
    type: z.literal(TxSubmitterType.GNOSIS_TX_BUILDER),
  }),
]);

export type SubmitterMetadata = z.infer<typeof SubmitterMetadataSchema>;
