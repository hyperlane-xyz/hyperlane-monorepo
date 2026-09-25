import type { DispatchEvent, ProcessEvent } from '@hyperlane-xyz/core/mailbox';

export { DispatchEvent, ProcessEvent };

export type HyperlaneLifecycleEvent = ProcessEvent | DispatchEvent;
