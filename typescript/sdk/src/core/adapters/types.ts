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
}
