import { pollAsync } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType';
import { CoreAddresses } from '../contracts';

import { ICoreAdapter } from './types';

// This adapter just routes to the HyperlaneCore
// Which implements the needed functionality for EVM chains
export class SealevelCoreAdapter
  extends BaseSealevelAdapter<CoreAddresses>
  implements ICoreAdapter
{
  async waitForMessageProcessed(
    sourceTx: TypedTransactionReceipt,
    delay?: number,
    maxAttempts?: number,
  ): Promise<void> {
    if (sourceTx.type !== ProviderType.SolanaWeb3) {
      throw new Error(
        `Unsupported provider type for SealevelCoreAdapter ${sourceTx.type}`,
      );
    }
    await pollAsync(
      async () => {
        const delivered = false;
        // TODO - implement this
        if (!delivered) throw new Error(`Message not yet processed`);
      },
      delay,
      maxAttempts,
    );
  }
}
