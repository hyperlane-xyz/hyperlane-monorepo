import {
  Address,
  HexString,
  ProtocolType,
  objMap,
  pick,
} from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp';
import {
  attachContractsMap,
  filterAddressesToProtocol,
} from '../../contracts/contracts';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType';
import { ChainName } from '../../types';
import { HyperlaneCore } from '../HyperlaneCore';
import { CoreAddresses, coreFactories } from '../contracts';

import { ICoreAdapter } from './types';

// Explicitly omit timelockController b.c. most chains don't have it in SDK artifacts
type CoreAddressKeys = keyof Omit<CoreAddresses, 'timelockController'>;

// This adapter just routes to the HyperlaneCore
// Which implements the needed functionality for EVM chains
export class EvmCoreAdapter
  extends BaseEvmAdapter<CoreAddresses>
  implements ICoreAdapter
{
  core: HyperlaneCore;

  constructor(
    public readonly multiProvider: MultiProtocolProvider<CoreAddresses>,
  ) {
    super(multiProvider);

    // Pick out the addresses from the metadata in the multiProvider
    // Reminder: MultiProtocol Apps expect the addresses to be in the metadata
    const contractNames = Object.keys(coreFactories) as Array<CoreAddressKeys>;
    const addresses = objMap(multiProvider.metadata, (_, m) =>
      pick<CoreAddressKeys, Address>(m, contractNames),
    );
    // Then filter it to just the addresses for Ethereum chains
    // Otherwise the factory creators will throw
    const filteredAddresses = filterAddressesToProtocol(
      addresses,
      ProtocolType.Ethereum,
      multiProvider,
    );
    const contractsMap = attachContractsMap(filteredAddresses, coreFactories);
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
