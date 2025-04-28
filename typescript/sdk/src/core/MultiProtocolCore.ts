import { HexString, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { AdapterClassType, MultiProtocolApp } from '../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { TypedTransactionReceipt } from '../providers/ProviderType.js';
import { ChainMap, ChainName } from '../types.js';

import { CosmNativeCoreAdapter } from './adapters/CosmNativeCoreAdapter.js';
import { CosmWasmCoreAdapter } from './adapters/CosmWasmCoreAdapter.js';
import { EvmCoreAdapter } from './adapters/EvmCoreAdapter.js';
import { SealevelCoreAdapter } from './adapters/SealevelCoreAdapter.js';
import { ICoreAdapter } from './adapters/types.js';
import { CoreAddresses } from './contracts.js';

export class MultiProtocolCore extends MultiProtocolApp<
  ICoreAdapter,
  CoreAddresses
> {
  constructor(
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: ChainMap<CoreAddresses>,
    public readonly logger = rootLogger.child({ module: 'MultiProtocolCore' }),
  ) {
    super(multiProvider, addresses, logger);
  }

  static fromAddressesMap(
    addressesMap: ChainMap<CoreAddresses>,
    multiProvider: MultiProtocolProvider,
  ): MultiProtocolCore {
    return new MultiProtocolCore(
      multiProvider.intersect(Object.keys(addressesMap)).result,
      addressesMap,
    );
  }

  override protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<ICoreAdapter> {
    if (protocol === ProtocolType.Ethereum) return EvmCoreAdapter;
    if (protocol === ProtocolType.Sealevel) return SealevelCoreAdapter;
    if (protocol === ProtocolType.Cosmos) return CosmWasmCoreAdapter;
    if (protocol === ProtocolType.CosmosNative) return CosmNativeCoreAdapter;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  extractMessageIds(
    origin: ChainName,
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: HexString; destination: ChainName }> {
    return this.adapter(origin).extractMessageIds(sourceTx);
  }

  async waitForMessagesProcessed(
    origin: ChainName,
    destination: ChainName,
    sourceTx: TypedTransactionReceipt,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean> {
    const messages = this.adapter(origin).extractMessageIds(sourceTx);
    await Promise.all(
      messages.map((msg) =>
        this.adapter(destination).waitForMessageProcessed(
          msg.messageId,
          msg.destination,
          delayMs,
          maxAttempts,
        ),
      ),
    );
    return true;
  }
}
