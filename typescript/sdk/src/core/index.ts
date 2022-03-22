export { AbacusCore } from './app';
export { CoreContractAddresses, CoreContracts } from './contracts';
export {
  AbacusLifecyleEvent,
  AnnotatedDispatch,
  AnnotatedLifecycleEvent,
} from './events';
export { AbacusMessage, AbacusStatus, MessageStatus } from './message';

import { AbacusCore } from './app';
import { test } from './environments';
export const core = {
  test: new AbacusCore(test),
};
