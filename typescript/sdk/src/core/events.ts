import type {
  DispatchEvent,
  ProcessEvent,
} from '@abacus-network/core/dist/contracts/Mailbox';

import { Annotated } from '../events';

export { DispatchEvent, ProcessEvent };

export type AbacusLifecyleEvent = ProcessEvent | DispatchEvent;

export type AnnotatedDispatch = Annotated<DispatchEvent>;
export type AnnotatedProcess = Annotated<ProcessEvent>;

export type AnnotatedLifecycleEvent = AnnotatedDispatch | AnnotatedProcess;
