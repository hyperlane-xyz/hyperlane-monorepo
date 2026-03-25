import { Address, Numberish, assert } from '@hyperlane-xyz/utils';

import type { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';
import { ChainName } from '../types.js';

import type { IToken } from './IToken.js';
import { TokenAmount } from './TokenAmount.js';
import { TokenConnection } from './TokenConnection.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenMetadata } from './TokenMetadata.js';
import type {
  IHypTokenAdapter,
  ITokenAdapter,
} from './adapters/ITokenAdapter.js';
import { hasOnlyHyperlaneConnections } from './adapters/hypTokenAdapterUtils.js';
import {
  getRegisteredCollateralTokenAdapterFactory,
  getRegisteredHypTokenAdapterFactory,
  getRegisteredTokenAdapterFactory,
} from './adapters/registry.js';

export class Token extends TokenMetadata implements IToken {
  override amount(amount: Numberish): TokenAmount<this> {
    return new TokenAmount(amount, this);
  }

  override getConnections(): TokenConnection<IToken>[] {
    // CAST: Token instances only store TokenConnection<IToken>; the base
    // TokenMetadata type widens this to ITokenMetadata for shared read paths.
    return (this.connections || []) as TokenConnection<IToken>[];
  }

  override getConnectionForChain(
    chain: ChainName,
  ): TokenConnection<IToken> | undefined {
    return this.getConnections().filter((t) => t.token.chainName === chain)[0];
  }

  override addConnection(connection: TokenConnection<IToken>): Token {
    this.connections = [...(this.connections || []), connection];
    return this;
  }

  override removeConnection(token: IToken): Token {
    super.removeConnection(token);
    return this;
  }

  /**
   * Returns a TokenAdapter for the token and multiProvider
   * @throws If multiProvider does not contain this token's chain.
   * @throws If token is an NFT (TODO NFT Adapter support)
   */
  getAdapter(multiProvider: MultiProviderAdapter): ITokenAdapter<unknown> {
    const { standard, chainName } = this;

    assert(!this.isNft(), 'NFT adapters not yet supported');
    assert(
      multiProvider.tryGetChainMetadata(chainName),
      `Token chain ${chainName} not found in multiProvider`,
    );

    if (standard === TokenStandard.CosmosIcs20) {
      throw new Error('Cosmos ICS20 token adapter not yet supported');
    }

    const adapterFactory = getRegisteredTokenAdapterFactory(standard);
    if (adapterFactory) {
      return adapterFactory({ multiProvider, token: this });
    }

    if (this.isHypToken()) {
      return this.getHypAdapter(multiProvider);
    }

    throw new Error(`No adapter found for token standard: ${standard}`);
  }

  /**
   * Returns a HypTokenAdapter for the token and multiProvider
   * @throws If not applicable to this token's standard.
   * @throws If multiProvider does not contain this token's chain.
   * @throws If token is an NFT (TODO NFT Adapter support)
   */
  getHypAdapter(
    multiProvider: MultiProviderAdapter<{ mailbox?: Address }>,
    destination?: ChainName,
  ): IHypTokenAdapter<unknown> {
    const { standard, chainName } = this;
    const chainMetadata = multiProvider.tryGetChainMetadata(chainName);
    const isConnectedNativeToken =
      (standard === TokenStandard.EvmNative ||
        standard === TokenStandard.TronNative) &&
      hasOnlyHyperlaneConnections(this);

    assert(
      this.isMultiChainToken() || isConnectedNativeToken,
      `Token standard ${standard} not applicable to hyp adapter`,
    );
    assert(!this.isNft(), 'NFT adapters not yet supported');
    assert(
      chainMetadata,
      `Token chain ${chainName} not found in multiProvider`,
    );

    const hypAdapter = getRegisteredHypTokenAdapterFactory(standard)?.({
      destination,
      multiProvider,
      token: this,
    });

    if (hypAdapter) {
      return hypAdapter;
    }

    throw new Error(`No hyp adapter found for token standard: ${standard}`);
  }

  /**
   * Convenience method to create an adapter and return an account balance
   */
  async getBalance(
    multiProvider: MultiProviderAdapter,
    address: Address,
  ): Promise<TokenAmount<IToken>> {
    const adapter = this.getAdapter(multiProvider);
    const balance = await adapter.getBalance(address);
    return new TokenAmount(balance, this);
  }
}

interface GetCollateralTokenAdapterOptions {
  multiProvider: MultiProviderAdapter;
  chainName: ChainName;
  tokenAddress: Address;
}

export function getCollateralTokenAdapter({
  chainName,
  multiProvider,
  tokenAddress,
}: GetCollateralTokenAdapterOptions): ITokenAdapter<unknown> {
  const protocolType = multiProvider.getProtocol(chainName);
  const adapterFactory =
    getRegisteredCollateralTokenAdapterFactory(protocolType);

  if (adapterFactory) {
    return adapterFactory({
      chainName,
      multiProvider,
      tokenAddress,
    });
  }

  throw new Error(
    `Unsupported protocol ${protocolType} for retrieving collateral token adapter on chain ${chainName}`,
  );
}
