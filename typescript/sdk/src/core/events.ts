import type {
  DispatchEvent,
  ProcessEvent,
} from '@hyperlane-xyz/core/dist/contracts/Mailbox';

export { DispatchEvent, ProcessEvent };

export type HyperlaneLifecyleEvent = ProcessEvent | DispatchEvent;
