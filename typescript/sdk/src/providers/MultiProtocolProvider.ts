import { Debugger, debug } from 'debug';

import { chainMetadata as defaultChainMetadata } from '../consts/chainMetadata';
import type { ChainMetadata } from '../metadata/chainMetadataTypes';
import type { ChainMap, ChainName } from '../types';

import { MultiProviderOptions, ReadOnlyMultiProvider } from './MultiProvider';
import { ProviderMap, ProviderType, TypedProvider } from './ProviderType';
import {
  ProviderBuilderMap,
  defaultProviderBuilderMap,
} from './providerBuilders';

/**
 * Type hacking to allow MultiProtocolProvider to extend MultiProvider
 * while still overriding the signature of some methods.
 * Alternatively, we could use composition and explicitly re-define all methods
 */

type MethodToExcludeFromInheritance =
  | 'tryGetProvider'
  | 'getProvider'
  | 'setProvider'
  | 'setProviders';

type PartialMultiProvider = new (
  ...params: ConstructorParameters<typeof ReadOnlyMultiProvider>
) => {
  [Method in Exclude<
    keyof ReadOnlyMultiProvider,
    MethodToExcludeFromInheritance
  >]: ReadOnlyMultiProvider[Method];
};
const PartialMultiProvider: PartialMultiProvider = ReadOnlyMultiProvider;

/**
 * A version of MultiProvider that can support different
 * provider types across different protocol types.
 *
 * This uses a different interface for provider/signer related methods
 * so it isn't strictly backwards compatible with MultiProvider.
 *
 * Unlike MultiProvider, this class does not support signer/signing methods (yet).
 */

export interface MultiProtocolProviderOptions extends MultiProviderOptions {
  providerBuilders?: Partial<ProviderBuilderMap>;
}

export class MultiProtocolProvider extends PartialMultiProvider {
  public readonly metadata: ChainMap<ChainMetadata> = {};
  protected readonly providers: ChainMap<ProviderMap<TypedProvider>> = {};
  protected signers: ChainMap<ProviderMap<never>> = {}; // TODO signer support
  protected readonly logger: Debugger;
  protected readonly providerBuilders: Partial<ProviderBuilderMap>;

  constructor(
    chainMetadata: ChainMap<ChainMetadata> = defaultChainMetadata,
    options: MultiProtocolProviderOptions = {},
  ) {
    super(chainMetadata, options);
    this.logger = debug(
      options?.loggerName || 'hyperlane:MultiProtocolProvider',
    );
    this.providerBuilders =
      options.providerBuilders || defaultProviderBuilderMap;
  }

  tryGetProvider(
    chainNameOrId: ChainName | number,
    type: ProviderType,
  ): TypedProvider | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    const { name, chainId, rpcUrls } = metadata;

    if (this.providers[name]?.[type]) return this.providers[name][type]!;

    const builder = this.providerBuilders[type];
    if (!rpcUrls.length || !builder) return null;

    const provider = builder(rpcUrls, chainId);
    this.providers[name] ||= {};
    this.providers[name][type] = provider;
    return provider;
  }

  getProvider(
    chainNameOrId: ChainName | number,
    type: ProviderType,
  ): TypedProvider {
    const provider = this.tryGetProvider(chainNameOrId, type);
    if (!provider)
      throw new Error(`No provider available for ${chainNameOrId}`);
    return provider;
  }

  setProvider(
    chainNameOrId: ChainName | number,
    provider: TypedProvider,
  ): TypedProvider {
    const chainName = this.getChainName(chainNameOrId);
    this.providers[chainName] ||= {};
    this.providers[chainName][provider.type] = provider;
    return provider;
  }

  setProviders(providers: ChainMap<TypedProvider>): void {
    for (const chain of Object.keys(providers)) {
      this.setProvider(chain, providers[chain]);
    }
  }
}
