import type {
  CheckpointCachedEvent,
  ProcessEvent,
} from '@abacus-network/core/types/contracts/Inbox';
import type { DispatchEvent } from '@abacus-network/core/types/contracts/Outbox';

import { Annotated } from '../events';

export { DispatchEvent, CheckpointCachedEvent, ProcessEvent };

export type AbacusLifecyleEvent =
  | ProcessEvent
  | CheckpointCachedEvent
  | DispatchEvent;

export type AnnotatedDispatch = Annotated<DispatchEvent>;
export type AnnotatedCheckpoint = Annotated<CheckpointCachedEvent>;
export type AnnotatedProcess = Annotated<ProcessEvent>;

export type AnnotatedLifecycleEvent =
  | AnnotatedDispatch
  | AnnotatedCheckpoint
  | AnnotatedProcess;
