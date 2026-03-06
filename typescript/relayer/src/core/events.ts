import type { DispatchedMessage } from '@hyperlane-xyz/sdk';

import type { DispatchReceipt } from './dispatchReceipt.js';

/**
 * Relayer events, useful for metrics and monitoring
 */
export type RelayerEvent =
  | {
      type: 'messageRelayed';
      message: DispatchedMessage;
      originChain: string;
      destinationChain: string;
      messageId: string;
      durationMs: number;
      dispatchTx?: DispatchReceipt;
    }
  | {
      type: 'messageFailed';
      message: DispatchedMessage;
      originChain: string;
      destinationChain: string;
      messageId: string;
      error: Error;
      dispatchTx?: DispatchReceipt;
    }
  | {
      type: 'messageSkipped';
      message: DispatchedMessage;
      originChain: string;
      destinationChain: string;
      messageId: string;
      reason: 'whitelist' | 'already_delivered';
      dispatchTx?: DispatchReceipt;
    }
  | {
      type: 'retry';
      message: DispatchedMessage;
      originChain: string;
      destinationChain: string;
      messageId: string;
      attempt: number;
    }
  | { type: 'backlog'; size: number };

export interface RelayerObserver {
  onEvent?: (event: RelayerEvent) => void;
}
