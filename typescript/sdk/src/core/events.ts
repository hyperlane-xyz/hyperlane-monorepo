import type { ProcessEvent } from '@hyperlane-xyz/core/dist/contracts/Inbox';
import type { DispatchEvent } from '@hyperlane-xyz/core/dist/contracts/Outbox';

import { Annotated } from '../events';

export { DispatchEvent, ProcessEvent };

export type HyperlaneLifecyleEvent = ProcessEvent | DispatchEvent;

export type AnnotatedDispatch = Annotated<DispatchEvent>;
export type AnnotatedProcess = Annotated<ProcessEvent>;

export type AnnotatedLifecycleEvent = AnnotatedDispatch | AnnotatedProcess;
