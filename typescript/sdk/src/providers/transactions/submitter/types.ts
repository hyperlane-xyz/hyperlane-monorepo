import { z } from 'zod';

import { TxSubmitterType } from './TxSubmitterTypes.js';
import {
  EV5GnosisSafeTxBuilderPropsSchema,
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
  EV5JsonRpcTxSubmitterPropsSchema,
} from './ethersV5/types.js';

export const SubmitterMetadataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(TxSubmitterType.JSON_RPC),
    ...EV5JsonRpcTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.IMPERSONATED_ACCOUNT),
    ...EV5ImpersonatedAccountTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.GNOSIS_SAFE),
    ...EV5GnosisSafeTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.GNOSIS_TX_BUILDER),
    ...EV5GnosisSafeTxBuilderPropsSchema.shape,
  }),
]);

export type SubmitterMetadata = z.infer<typeof SubmitterMetadataSchema>;
