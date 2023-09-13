import { Mailbox__factory } from '@hyperlane-xyz/core';
import { Address, HexString } from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp';
import { HyperlaneContractsMap } from '../../contracts/types';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType';
import { ChainName } from '../../types';
import { HyperlaneCore } from '../HyperlaneCore';
import { CoreFactories } from '../contracts';

import { ICoreAdapter } from './types';

// This adapter just routes to the HyperlaneCore
// Which implements the needed functionality for EVM chains
// TODO deprecate HyperlaneCore and replace all evm-specific classes with adapters
export class EvmCoreAdapter extends BaseEvmAdapter implements ICoreAdapter {
  core: HyperlaneCore;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
    const contractsMap = {
      [chainName]: {
        mailbox: Mailbox__factory.connect(
          addresses.mailbox,
          multiProvider.getEthersV5Provider(chainName),
        ),
      },
    } as HyperlaneContractsMap<CoreFactories>; // Core only uses mailbox so cast to keep adapter interface simple
    this.core = new HyperlaneCore(
      contractsMap,
      multiProvider.toMultiProvider(),
    );
  }

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.EthersV5) {
      throw new Error(
        `Unsupported provider type for EvmCoreAdapter ${sourceTx.type}`,
      );
    }
    const messages = this.core.getDispatchedMessages(sourceTx.receipt);
    return messages.map(({ id, parsed }) => ({
      messageId: id,
      destination: this.multiProvider.getChainName(parsed.destination),
    }));
  }

  waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<void> {
    return this.core.waitForMessageIdProcessed(
      messageId,
      destination,
      delayMs,
      maxAttempts,
    );
  }
}
