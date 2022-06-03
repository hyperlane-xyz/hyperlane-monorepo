import type { ProcessEvent } from '@abacus-network/core/types/contracts/Inbox';
import type { DispatchEvent } from '@abacus-network/core/types/contracts/Outbox';

import { Annotated } from '../events';

export { DispatchEvent, ProcessEvent };

export type AbacusLifecyleEvent = ProcessEvent | DispatchEvent;

export type AnnotatedDispatch = Annotated<DispatchEvent>;
export type AnnotatedProcess = Annotated<ProcessEvent>;

export type AnnotatedLifecycleEvent = AnnotatedDispatch | AnnotatedProcess;
