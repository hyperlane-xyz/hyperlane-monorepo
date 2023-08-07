import { Address, objMap, pick } from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType';
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
    public readonly multiProtocolProvider: MultiProtocolProvider<CoreAddresses>,
  ) {
    super(multiProtocolProvider);

    // Pick out the addresses from the metadata in the multiProvider
    // Reminder: MultiProtocol Apps expect the addresses to be in the metadata
    const contractNames = Object.keys(coreFactories) as Array<CoreAddressKeys>;
    const addresses = objMap(multiProtocolProvider.metadata, (_, m) =>
      pick<CoreAddressKeys, Address>(m, contractNames),
    );

    this.core = HyperlaneCore.fromAddressesMap(
      addresses,
      multiProtocolProvider.toMultiProvider(),
    );
  }

  waitForMessageProcessed(
    sourceTx: TypedTransactionReceipt,
    delay?: number,
    maxAttempts?: number,
  ): Promise<void> {
    if (sourceTx.type !== ProviderType.EthersV5) {
      throw new Error(
        `Unsupported provider type for EvmCoreAdapter ${sourceTx.type}`,
      );
    }
    return this.core.waitForMessageProcessed(
      sourceTx.receipt,
      delay,
      maxAttempts,
    );
  }
}
