import type { HexString } from '@hyperlane-xyz/utils';

import type { BaseAppAdapter } from '../../app/MultiProtocolApp.js';
import type { TypedTransactionReceipt } from '../../providers/ProviderType.js';
import type { ChainName } from '../../types.js';

export interface ICoreAdapter extends BaseAppAdapter {
  extractMessageIds(
    r: TypedTransactionReceipt,
  ): Array<{ messageId: HexString; destination: ChainName }>;
  waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean>;
  /**
   * Check if a message has been delivered on this chain.
   * @param messageId - The message ID to check
   * @param blockTag - Optional block tag for finality checks (EVM only)
   * @returns true if the message has been delivered, false otherwise
   */
  isDelivered(
    messageId: HexString,
    blockTag?: string | number,
  ): Promise<boolean>;
}
