import type { HexString } from '@hyperlane-xyz/utils';

import type { BaseAppAdapter } from '../../app/MultiProtocolApp';
import type { TypedTransactionReceipt } from '../../providers/ProviderType';
import type { ChainName } from '../../types';
import type { CoreAddresses } from '../contracts';

export interface ICoreAdapter extends BaseAppAdapter<CoreAddresses> {
  extractMessageIds(
    r: TypedTransactionReceipt,
  ): Array<{ messageId: HexString; destination: ChainName }>;
  waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<void>;
}
