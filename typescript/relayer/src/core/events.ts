import type { TransactionReceipt } from 'ethers';

import type { DispatchedMessage } from '@hyperlane-xyz/sdk';

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
      dispatchTx?: TransactionReceipt;
    }
  | {
      type: 'messageFailed';
      message: DispatchedMessage;
      originChain: string;
      destinationChain: string;
      messageId: string;
      error: Error;
      dispatchTx?: TransactionReceipt;
    }
  | {
      type: 'messageSkipped';
      message: DispatchedMessage;
      originChain: string;
      destinationChain: string;
      messageId: string;
      reason: 'whitelist' | 'already_delivered';
      dispatchTx?: TransactionReceipt;
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
