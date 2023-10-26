import { HexString } from '@hyperlane-xyz/utils';

import { BaseCwAdapter } from '../../app/MultiProtocolApp';
import { ChainName } from '../../types';

import { ProviderType, TypedTransactionReceipt } from '../../providers/ProviderType';
import { ICoreAdapter } from './types';

// This adapter just routes to the HyperlaneCore
// Which implements the needed functionality for Cw chains
// TODO deprecate HyperlaneCore and replace all Cw-specific classes with adapters
export class CwCoreAdapter extends BaseCwAdapter implements ICoreAdapter {
  public readonly contractAddress = this.addresses.mailbox;

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.Cosmos) {
      throw new Error(
        `Unsupported provider type for CosmosCoreAdapter ${sourceTx.type}`,
      );
    }
    // TODO: parse mailbox logs and extract message ids
    throw new Error("Method not implemented.");
  }

  async waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
