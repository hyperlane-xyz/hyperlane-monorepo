import type { ProcessEvent } from '@abacus-network/core/dist/contracts/Inbox';
import type { DispatchEvent } from '@abacus-network/core/dist/contracts/Outbox';

import { Annotated } from '../events';

export { DispatchEvent, ProcessEvent };

export type AbacusLifecyleEvent = ProcessEvent | DispatchEvent;

export type AnnotatedDispatch = Annotated<DispatchEvent>;
export type AnnotatedProcess = Annotated<ProcessEvent>;

export type AnnotatedLifecycleEvent = AnnotatedDispatch | AnnotatedProcess;
