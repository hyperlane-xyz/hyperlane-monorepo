import { z } from 'zod';

import {
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
} from './schemas.js';

export type EV5GnosisSafeTxSubmitterProps = z.infer<
  typeof EV5GnosisSafeTxSubmitterPropsSchema
>;
export type EV5ImpersonatedAccountTxSubmitterProps = z.infer<
  typeof EV5ImpersonatedAccountTxSubmitterPropsSchema
>;
