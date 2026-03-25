/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import {
  KnownProtocolType,
  Numberish,
  ProtocolType,
  assert,
  eqAddress,
} from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainName } from '../types.js';

import type { ITokenMetadata, TokenArgs } from './ITokenMetadata.js';
import type { TokenConnection } from './TokenConnection.js';
import { TokenAmount } from './TokenAmount.js';
import {
  PROTOCOL_TO_HYP_NATIVE_STANDARD,
  PROTOCOL_TO_NATIVE_STANDARD,
  TOKEN_COLLATERALIZED_STANDARDS,
  TOKEN_HYP_STANDARDS,
  TOKEN_MULTI_CHAIN_STANDARDS,
  TOKEN_NFT_STANDARDS,
  TOKEN_STANDARD_TO_PROTOCOL,
  TokenStandard,
  XERC20_STANDARDS,
} from './TokenStandard.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from './nativeTokenMetadata.js';

export interface TokenMetadata extends TokenArgs {}

export class TokenMetadata implements ITokenMetadata {
  public readonly protocol: ProtocolType;

  constructor(args: TokenArgs) {
    Object.assign(this, args);
    this.protocol = TOKEN_STANDARD_TO_PROTOCOL[this.standard];
  }

  static FromChainMetadataNativeToken<T extends typeof TokenMetadata>(
    this: T,
    chainMetadata: ChainMetadata,
  ): InstanceType<T> {
    const {
      protocol,
      name: chainName,
      logoURI,
      gasCurrencyCoinGeckoId,
    } = chainMetadata;
    assert(
      protocol !== ProtocolType.Unknown,
      'Cannot create native token for unknown protocol',
    );
    const knownProtocol = protocol as KnownProtocolType;
    const nativeToken =
      chainMetadata.nativeToken ||
      PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[knownProtocol];

    return new this({
      chainName,
      standard: PROTOCOL_TO_NATIVE_STANDARD[knownProtocol],
      addressOrDenom: nativeToken.denom ?? '',
      decimals: nativeToken.decimals,
      symbol: nativeToken.symbol,
      name: nativeToken.name,
      logoURI,
      coinGeckoId: gasCurrencyCoinGeckoId,
    }) as InstanceType<T>;
  }

  amount(amount: Numberish): TokenAmount<this> {
    return new TokenAmount(amount, this);
  }

  isNft(): boolean {
    return TOKEN_NFT_STANDARDS.includes(this.standard);
  }

  isNative(): boolean {
    return Object.values(PROTOCOL_TO_NATIVE_STANDARD).includes(this.standard);
  }

  isHypNative(): boolean {
    return Object.values(PROTOCOL_TO_HYP_NATIVE_STANDARD).includes(
      this.standard,
    );
  }

  isCollateralized(): boolean {
    return TOKEN_COLLATERALIZED_STANDARDS.includes(this.standard);
  }

  isHypToken(): boolean {
    return TOKEN_HYP_STANDARDS.includes(this.standard);
  }

  isXerc20(): boolean {
    return XERC20_STANDARDS.includes(this.standard);
  }

  isIbcToken(): boolean {
    return this.standard === TokenStandard.CosmosIbc;
  }

  isMultiChainToken(): boolean {
    return TOKEN_MULTI_CHAIN_STANDARDS.includes(this.standard);
  }

  isCrossCollateralToken(): boolean {
    return (
      this.standard === TokenStandard.EvmHypCrossCollateralRouter ||
      this.standard === TokenStandard.TronHypCrossCollateralRouter
    );
  }

  getConnections(): TokenConnection[] {
    return this.connections || [];
  }

  getConnectionForChain(chain: ChainName): TokenConnection | undefined {
    return this.getConnections().filter((t) => t.token.chainName === chain)[0];
  }

  addConnection(connection: TokenConnection): TokenMetadata {
    this.connections = [...(this.connections || []), connection];
    return this;
  }

  removeConnection(token: ITokenMetadata): TokenMetadata {
    const index = this.connections?.findIndex((t) => t.token.equals(token));
    if (index && index >= 0) this.connections?.splice(index, 1);
    return this;
  }

  equals(token?: ITokenMetadata): boolean {
    if (!token) return false;
    return (
      this.protocol === token.protocol &&
      this.chainName === token.chainName &&
      this.standard === token.standard &&
      this.decimals === token.decimals &&
      this.addressOrDenom.toLowerCase() ===
        token.addressOrDenom.toLowerCase() &&
      this.collateralAddressOrDenom?.toLowerCase() ===
        token.collateralAddressOrDenom?.toLowerCase()
    );
  }

  isFungibleWith(token?: ITokenMetadata): boolean {
    if (!token || token.chainName !== this.chainName) return false;

    if (this.equals(token)) return true;

    if (this.isCollateralized()) {
      if (
        this.collateralAddressOrDenom &&
        eqAddress(this.collateralAddressOrDenom, token.addressOrDenom)
      ) {
        return true;
      }

      if (
        !this.collateralAddressOrDenom &&
        (token.isNative() || token.isHypNative())
      ) {
        return true;
      }
    }

    if (
      this.standard === TokenStandard.CosmosIbc &&
      token.standard === TokenStandard.CosmosNative &&
      this.addressOrDenom.toLowerCase() === token.addressOrDenom.toLowerCase()
    ) {
      return true;
    }

    return false;
  }
}
