import { Address, HexString } from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp';
import {
  MessageDeliveredResponse,
  QueryMsg,
} from '../../cw-types/Mailbox.types';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType';
import { ChainName } from '../../types';

import { ICoreAdapter } from './types';

type MailboxResponse = MessageDeliveredResponse;

// This adapter just routes to the HyperlaneCore
// Which implements the needed functionality for Cw chains
// TODO deprecate HyperlaneCore and replace all Cw-specific classes with adapters
export class CosmWasmCoreAdapter
  extends BaseCosmWasmAdapter
  implements ICoreAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async queryMailbox<R extends MailboxResponse>(msg: QueryMsg): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.mailbox,
      msg,
    );
    return response;
  }

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.CosmJsWasm) {
      throw new Error(
        `Unsupported provider type for CosmosCoreAdapter ${sourceTx.type}`,
      );
    }
    // TODO: parse mailbox logs and extract message ids
    throw new Error('Method not implemented.');
  }

  async waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<void> {
    throw new Error('Method not implemented.');
  }
}
