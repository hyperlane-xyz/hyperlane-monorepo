import {
  Address,
  HexString,
  ProtocolType,
  objFilter,
  objMap,
  pick,
} from '@hyperlane-xyz/utils';

import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';
import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainMap, ChainName, ChainNameOrId } from '../types.js';

import {
  MinimalProviderRegistry,
  MinimalProviderRegistryOptions,
} from './MinimalProviderRegistry.js';
import { MultiProvider, MultiProviderOptions } from './MultiProvider.js';
import { SeismicSigner } from './SeismicSigner.js';
import {
  EthersV5Provider,
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  ProviderType,
  TypedTransaction,
  TypedProvider,
} from './ProviderType.js';
import { defaultZKSyncProviderBuilder } from './builders/zksync.js';
import type { ProviderBuilderFn } from './providerBuilders.js';
import {
  TransactionFeeEstimate,
  TransactionFeeEstimateOptions,
  estimateTransactionFee,
} from './transactionFeeEstimators.js';

export interface MultiProviderAdapterOptions extends MinimalProviderRegistryOptions {
  /**
   * Signers for Seismic chains only, used for signed reads of shielded state
   * (see `tryGetSeismicSigner`). Adapters are otherwise read-only and never
   * hold key material; this is deliberately not a general signer registry.
   */
  seismicSigners?: ChainMap<SeismicSigner>;
}

/**
 * Picks the signers of Seismic chains out of a MultiProvider. MultiProvider
 * already wraps those in SeismicSigner; anything else is dropped.
 */
export function pickSeismicSigners<MetaExt = {}>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  mp: MultiProvider<MetaExt>,
): ChainMap<SeismicSigner> {
  const seismicSigners: ChainMap<SeismicSigner> = {};
  for (const chain of Object.keys(mp.signers)) {
    if (chainMetadata[chain]?.technicalStack !== ChainTechnicalStack.Seismic)
      continue;
    const signer = mp.tryGetSigner(chain);
    if (signer && SeismicSigner.is(signer)) seismicSigners[chain] = signer;
  }
  return seismicSigners;
}

export function wrapMultiProviderProviders<MetaExt = {}>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  providers: MultiProvider<MetaExt>['providers'],
): ChainMap<TypedProvider> {
  // CAST: objMap preserves the chain keys, but its generic return type does not
  // narrow back to ChainMap<TypedProvider>.
  return objMap(providers, (chain, provider) => ({
    type:
      chainMetadata[chain]?.technicalStack === ChainTechnicalStack.ZkSync
        ? ProviderType.ZkSync
        : ProviderType.EthersV5,
    provider,
  })) as ChainMap<TypedProvider>;
}

function wrapMultiProviderBuilder(
  providerBuilder: MultiProvider['providerBuilder'],
): ProviderBuilderFn<TypedProvider> {
  return (metadata) => ({
    type: ProviderType.EthersV5,
    provider: providerBuilder(metadata),
  });
}

function unwrapEthersProviderBuilder(
  providerBuilder?: ProviderBuilderFn<TypedProvider>,
): MultiProviderOptions['providerBuilder'] | undefined {
  if (!providerBuilder) return undefined;
  return (metadata) => {
    const provider = providerBuilder(metadata);
    if (provider.type !== ProviderType.EthersV5) {
      throw new Error(
        `Cannot convert ${provider.type} builder into a MultiProvider EthersV5 builder`,
      );
    }
    return provider.provider;
  };
}

export function createAdapterFromMultiProvider<
  MetaExt = {},
  TOptions extends MultiProviderAdapterOptions = MultiProviderAdapterOptions,
  TAdapter extends MultiProviderAdapter<MetaExt> =
    MultiProviderAdapter<MetaExt>,
>(
  AdapterClass: new (
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    options?: TOptions,
  ) => TAdapter,
  mp: MultiProvider<MetaExt>,
  options?: TOptions,
): TAdapter {
  const adapterOptions =
    // CAST: preserve adapter-specific option fields while injecting the bridged builder map.
    {
      ...options,
      providerBuilders: {
        ...options?.providerBuilders,
        [ProviderType.EthersV5]: wrapMultiProviderBuilder(mp.providerBuilder),
        [ProviderType.ZkSync]: defaultZKSyncProviderBuilder,
      },
      seismicSigners: {
        ...options?.seismicSigners,
        ...pickSeismicSigners(mp.metadata, mp),
      },
    } as TOptions;
  const newMp = new AdapterClass(mp.metadata, adapterOptions);
  newMp.setProviders(wrapMultiProviderProviders(mp.metadata, mp.providers));
  return newMp;
}

export class MultiProviderAdapter<
  MetaExt = {},
> extends MinimalProviderRegistry<MetaExt> {
  protected getDefaultProviderType(
    chainNameOrId: ChainNameOrId,
  ): ProviderType | undefined {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return undefined;
    if (
      metadata.protocol === ProtocolType.Ethereum &&
      metadata.technicalStack === ChainTechnicalStack.ZkSync
    ) {
      return ProviderType.ZkSync;
    }
    if (metadata.protocol === ProtocolType.Unknown) return undefined;
    return PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[metadata.protocol];
  }

  /** Signed-read signers for Seismic chains; see `MultiProviderAdapterOptions`. */
  protected seismicSigners: ChainMap<SeismicSigner>;

  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    protected readonly options: MultiProviderAdapterOptions = {},
  ) {
    super(chainMetadata, options);
    this.seismicSigners = { ...options.seismicSigners };
  }

  static fromMultiProvider<MetaExt = {}>(
    mp: MultiProvider<MetaExt>,
    options: MultiProviderAdapterOptions = {},
  ): MultiProviderAdapter<MetaExt> {
    return createAdapterFromMultiProvider(MultiProviderAdapter, mp, options);
  }

  /**
   * Signer for signed reads on a Seismic chain, if one was supplied (e.g. via
   * `fromMultiProvider` from a MultiProvider holding that chain's signer).
   * Always undefined for non-Seismic chains and for read-only instances.
   */
  tryGetSeismicSigner(chainNameOrId: ChainNameOrId): SeismicSigner | undefined {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (metadata?.technicalStack !== ChainTechnicalStack.Seismic)
      return undefined;
    return this.seismicSigners[metadata.name];
  }

  /**
   * Adopts the Seismic chains' signers of a MultiProvider, for instances that
   * were built from metadata before signers existed (the CLI creates its
   * MultiProtocolProvider at context setup and attaches keys afterwards).
   * Only Seismic chains are considered; see `seismicSigners`.
   */
  setSeismicSigners(mp: MultiProvider<any>): void {
    this.seismicSigners = {
      ...this.seismicSigners,
      ...pickSeismicSigners(this.metadata, mp),
    };
  }

  override tryGetProvider(
    chainNameOrId: ChainNameOrId,
    type?: ProviderType,
  ): TypedProvider | null {
    return super.tryGetProvider(
      chainNameOrId,
      type ?? this.getDefaultProviderType(chainNameOrId),
    );
  }

  toMultiProvider(options?: MultiProviderOptions): MultiProvider<MetaExt> {
    const newMp = new MultiProvider<MetaExt>(this.metadata, {
      ...options,
      providerBuilder:
        options?.providerBuilder ||
        unwrapEthersProviderBuilder(
          this.providerBuilders[ProviderType.EthersV5],
        ),
    });

    const providers = objMap(
      this.providers,
      (_, typeToProviders) => typeToProviders[ProviderType.EthersV5]?.provider,
    ) as ChainMap<EthersV5Provider['provider'] | undefined>;

    const filteredProviders = objFilter(
      providers,
      (_, p): p is EthersV5Provider['provider'] => !!p,
    ) as ChainMap<EthersV5Provider['provider']>;

    newMp.setProviders(filteredProviders);
    return newMp;
  }

  override extendChainMetadata<NewExt = {}>(
    additionalMetadata: ChainMap<NewExt>,
  ): MultiProviderAdapter<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    return new MultiProviderAdapter(newMetadata, {
      ...this.options,
      providers: this.providers,
      providerBuilders: this.providerBuilders,
      seismicSigners: this.seismicSigners,
    });
  }

  override intersect(
    chains: ChainName[],
    throwIfNotSubset = false,
  ): {
    intersection: ChainName[];
    result: MultiProviderAdapter<MetaExt>;
  } {
    const { intersection, result } = super.intersect(chains, throwIfNotSubset);
    return {
      intersection,
      result: new MultiProviderAdapter(result.metadata, {
        ...this.options,
        providers: pick(this.providers, intersection),
        providerBuilders: this.providerBuilders,
        seismicSigners: pick(this.seismicSigners, intersection),
      }),
    };
  }

  estimateTransactionFee({
    chainNameOrId,
    transaction,
    sender,
    senderPubKey,
    ignoreSenderBalance,
  }: {
    chainNameOrId: ChainNameOrId;
    transaction: TypedTransaction;
    sender: Address;
    senderPubKey?: HexString;
  } & TransactionFeeEstimateOptions): Promise<TransactionFeeEstimate> {
    const provider = this.getProvider(chainNameOrId, transaction.type);
    const chainMetadata = this.getChainMetadata(chainNameOrId);
    return estimateTransactionFee({
      transaction,
      provider,
      chainMetadata,
      sender,
      senderPubKey,
      ignoreSenderBalance,
    });
  }
}
