import { z } from 'zod';

import {
  EV5GnosisSafeTxBuilderPropsSchema,
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
  EV5JsonRpcTxSubmitterPropsSchema,
} from './schemas.js';

export type EV5GnosisSafeTxSubmitterProps = z.infer<
  typeof EV5GnosisSafeTxSubmitterPropsSchema
>;
export type EV5GnosisSafeTxBuilderProps = z.infer<
  typeof EV5GnosisSafeTxBuilderPropsSchema
>;
export type EV5JsonRpcTxSubmitterProps = z.infer<
  typeof EV5JsonRpcTxSubmitterPropsSchema
>;
export type EV5ImpersonatedAccountTxSubmitterProps = z.infer<
  typeof EV5ImpersonatedAccountTxSubmitterPropsSchema
>;
