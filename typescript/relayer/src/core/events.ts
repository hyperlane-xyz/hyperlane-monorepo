import type { providers } from 'ethers';

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
      dispatchTx?: providers.TransactionReceipt;
    }
  | {
      type: 'messageFailed';
      message: DispatchedMessage;
      originChain: string;
      destinationChain: string;
      messageId: string;
      error: Error;
      dispatchTx?: providers.TransactionReceipt;
    }
  | {
      type: 'messageSkipped';
      message: DispatchedMessage;
      originChain: string;
      destinationChain: string;
      messageId: string;
      reason: 'whitelist' | 'already_delivered';
      dispatchTx?: providers.TransactionReceipt;
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
