import { Address, assert } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '../providers/ConfiguredMultiProtocolProvider.js';
import type { ITokenMetadata, TokenArgs } from '../token/ITokenMetadata.js';
import type { TokenConnection } from '../token/TokenConnection.js';
import { TokenMetadata } from '../token/TokenMetadata.js';
import { parseTokenConnectionId } from '../token/TokenConnection.js';
import type { ChainName, ChainNameOrId } from '../types.js';

import { WarpCoreConfigSchema, type WarpCoreConfig } from './types.js';

export function buildWarpRouteTokens<TToken extends ITokenMetadata>(
  config: WarpCoreConfig,
  createToken: (tokenArgs: TokenArgs) => TToken,
): TToken[] {
  const tokens = config.tokens.map((token) =>
    createToken({
      ...token,
      addressOrDenom: token.addressOrDenom || '',
      connections: undefined,
    }),
  );

  config.tokens.forEach((tokenConfig, i) => {
    for (const connection of tokenConfig.connections || []) {
      const token1 = tokens[i];
      assert(token1, `Token config missing at index ${i}`);
      const { chainName, addressOrDenom } = parseTokenConnectionId(
        connection.token,
      );
      const token2 = tokens.find(
        (token) =>
          token.chainName === chainName &&
          token.addressOrDenom === addressOrDenom &&
          (!token1.warpRouteId || token.warpRouteId === token1.warpRouteId),
      );
      assert(
        token2,
        `Connected token not found: ${chainName} ${addressOrDenom}`,
      );
      token1.addConnection({
        ...connection,
        token: token2,
      });
    }
  });

  return tokens;
}

function matchesTokenIdentity(
  token: ITokenMetadata,
  reference: ITokenMetadata,
): boolean {
  return (
    token.chainName === reference.chainName &&
    token.addressOrDenom === reference.addressOrDenom &&
    (!reference.warpRouteId || token.warpRouteId === reference.warpRouteId)
  );
}

function toTokenArgs(token: ITokenMetadata): TokenArgs {
  return {
    chainName: token.chainName,
    standard: token.standard,
    decimals: token.decimals,
    symbol: token.symbol,
    name: token.name,
    addressOrDenom: token.addressOrDenom,
    collateralAddressOrDenom: token.collateralAddressOrDenom,
    igpTokenAddressOrDenom: token.igpTokenAddressOrDenom,
    logoURI: token.logoURI,
    coinGeckoId: token.coinGeckoId,
    scale: token.scale,
    warpRouteId: token.warpRouteId,
    connections: undefined,
  };
}

export function mapWarpRouteTokens<
  TSourceToken extends ITokenMetadata,
  TTargetToken extends ITokenMetadata,
>(
  tokens: TSourceToken[],
  createToken: (tokenArgs: TokenArgs) => TTargetToken,
): TTargetToken[] {
  const mappedTokens = tokens.map((token) => createToken(toTokenArgs(token)));

  tokens.forEach((token, i) => {
    for (const connection of token.getConnections()) {
      const mappedToken = mappedTokens[i];
      assert(mappedToken, `Mapped token missing at index ${i}`);
      const mappedConnectionToken = mappedTokens.find((candidate) =>
        matchesTokenIdentity(candidate, connection.token),
      );
      assert(
        mappedConnectionToken,
        `Mapped connection token not found: ${connection.token.chainName} ${connection.token.addressOrDenom}`,
      );
      mappedToken.addConnection({
        ...connection,
        token: mappedConnectionToken,
      } as TokenConnection<TTargetToken>);
    }
  });

  return mappedTokens;
}

export class WarpRouteGraph<TToken extends ITokenMetadata = TokenMetadata> {
  constructor(
    public readonly multiProvider: MultiProtocolProvider<{ mailbox?: Address }>,
    public readonly tokens: TToken[],
  ) {}

  static FromConfig(
    multiProvider: MultiProtocolProvider<{ mailbox?: Address }>,
    config: unknown,
  ): WarpRouteGraph<TokenMetadata> {
    const parsedConfig = WarpCoreConfigSchema.parse(config);
    const tokens = buildWarpRouteTokens(
      parsedConfig,
      (token) => new TokenMetadata(token),
    );
    return new WarpRouteGraph(multiProvider, tokens);
  }

  protected createNativeToken(chainMetadata: ChainMetadata): TToken {
    return TokenMetadata.FromChainMetadataNativeToken(
      chainMetadata,
    ) as unknown as TToken;
  }

  mapTokens<TMappedToken extends ITokenMetadata>(
    createToken: (tokenArgs: TokenArgs) => TMappedToken,
  ): WarpRouteGraph<TMappedToken> {
    return new WarpRouteGraph(
      this.multiProvider,
      mapWarpRouteTokens(this.tokens, createToken),
    );
  }

  protected resolveDestinationToken({
    originToken,
    destination,
    destinationToken,
  }: {
    originToken: ITokenMetadata;
    destination: ChainNameOrId;
    destinationToken?: ITokenMetadata;
  }): TToken {
    const destinationName = this.multiProvider.getChainName(destination);
    const destinationCandidates = originToken
      .getConnections()
      .filter((connection) => connection.token.chainName === destinationName)
      .map((connection) => connection.token as TToken);

    assert(
      destinationCandidates.length > 0,
      `No connection found for ${destinationName}`,
    );

    if (destinationToken) {
      assert(
        destinationToken.chainName === destinationName,
        `Destination token chain mismatch for ${destinationName}`,
      );
      const matchedToken = destinationCandidates.find(
        (candidate) =>
          candidate.equals(destinationToken) ||
          candidate.addressOrDenom.toLowerCase() ===
            destinationToken.addressOrDenom.toLowerCase(),
      );
      assert(
        matchedToken,
        `Destination token ${destinationToken.addressOrDenom} is not connected from ${originToken.chainName} to ${destinationName}`,
      );
      return matchedToken;
    }

    assert(
      destinationCandidates.length === 1,
      `Ambiguous route to ${destinationName}; specify destination token`,
    );
    return destinationCandidates[0];
  }

  findToken(
    chainName: ChainName,
    addressOrDenom?: Address | string,
  ): TToken | null {
    if (!addressOrDenom) return null;

    const results = this.tokens.filter(
      (token) =>
        token.chainName === chainName &&
        token.addressOrDenom.toLowerCase() === addressOrDenom.toLowerCase(),
    );

    if (results.length === 1) return results[0];

    if (results.length > 1)
      throw new Error(`Ambiguous token search results for ${addressOrDenom}`);

    const chainMetadata = this.multiProvider.getChainMetadata(chainName);
    if (chainMetadata.nativeToken?.denom === addressOrDenom) {
      return this.createNativeToken(chainMetadata);
    }

    return null;
  }

  getTokenChains(): ChainName[] {
    return [...new Set(this.tokens.map((token) => token.chainName)).values()];
  }

  getTokensForChain(chainName: ChainName): TToken[] {
    return this.tokens.filter((token) => token.chainName === chainName);
  }

  getTokensForRoute(origin: ChainName, destination: ChainName): TToken[] {
    return this.tokens.filter(
      (token) =>
        token.chainName === origin && token.getConnectionForChain(destination),
    );
  }
}
