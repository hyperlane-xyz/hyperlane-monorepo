import debug from 'debug';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { AdapterClassType, MultiProtocolApp } from '../app/MultiProtocolApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';
import { TypedTransactionReceipt } from '../providers/ProviderType';
import { ChainMap, ChainName } from '../types';

import { EvmCoreAdapter } from './adapters/EvmCoreAdapter';
import { SealevelCoreAdapter } from './adapters/SealevelCoreAdapter';
import { ICoreAdapter } from './adapters/types';
import { CoreAddresses } from './contracts';

export class MultiProtocolCore extends MultiProtocolApp<
  CoreAddresses,
  ICoreAdapter
> {
  constructor(
    public readonly multiProvider: MultiProtocolProvider<CoreAddresses>,
    public readonly logger = debug('hyperlane:MultiProtocolCore'),
  ) {
    super(multiProvider, logger);
  }

  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProtocolProvider,
  ): MultiProtocolCore {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    return MultiProtocolCore.fromAddressesMap(envAddresses, multiProvider);
  }

  static fromAddressesMap(
    addressesMap: ChainMap<CoreAddresses>,
    multiProvider: MultiProtocolProvider,
  ): MultiProtocolCore {
    const mpWithAddresses = multiProvider
      .intersect(Object.keys(addressesMap))
      .result.extendChainMetadata(addressesMap);
    return new MultiProtocolCore(mpWithAddresses);
  }

  override protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<ICoreAdapter> {
    if (protocol === ProtocolType.Ethereum) return EvmCoreAdapter;
    if (protocol === ProtocolType.Sealevel) return SealevelCoreAdapter;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  waitForMessagesProcessed(
    origin: ChainName,
    destination: ChainName,
    sourceTx: TypedTransactionReceipt,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<void[]> {
    const messages = this.adapter(origin).extractMessageIds(sourceTx);
    return Promise.all(
      messages.map((msg) =>
        this.adapter(destination).waitForMessageProcessed(
          msg.messageId,
          msg.destination,
          delayMs,
          maxAttempts,
        ),
      ),
    );
  }
}
