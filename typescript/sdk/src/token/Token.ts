import { MsgTransferEncodeObject } from '@cosmjs/stargate';

import {
  Address,
  Numberish,
  ProtocolType,
  assert,
  isEVMLike,
} from '@hyperlane-xyz/utils';

import type { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';
import { ChainName } from '../types.js';

import type { IToken } from './IToken.js';
import { TokenAmount } from './TokenAmount.js';
import { TokenConnection, TokenConnectionType } from './TokenConnection.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenMetadata } from './TokenMetadata.js';
import { AleoNativeTokenAdapter } from './adapters/AleoTokenAdapter.js';
import {
  CwNativeTokenAdapter,
  CwTokenAdapter,
} from './adapters/CosmWasmTokenAdapter.js';
import {
  CosmIbcToWarpTokenAdapter,
  CosmIbcTokenAdapter,
  CosmNativeTokenAdapter,
} from './adapters/CosmosTokenAdapter.js';
import {
  EvmNativeTokenAdapter,
  EvmTokenAdapter,
} from './adapters/EvmTokenAdapter.js';
import type {
  IHypTokenAdapter,
  ITokenAdapter,
} from './adapters/ITokenAdapter.js';
import { M0PortalLiteTokenAdapter } from './adapters/M0PortalLiteTokenAdapter.js';
import { M0PortalTokenAdapter } from './adapters/M0PortalTokenAdapter.js';
import {
  RadixNativeTokenAdapter,
  RadixTokenAdapter,
} from './adapters/RadixTokenAdapter.js';
import {
  SealevelNativeTokenAdapter,
  SealevelTokenAdapter,
} from './adapters/SealevelTokenAdapter.js';
import { StarknetTokenAdapter } from './adapters/StarknetTokenAdapter.js';
import { createAleoHypAdapter } from './adapters/aleoHyp.js';
import { createCosmosHypAdapter } from './adapters/cosmosHyp.js';
import { createEvmHypAdapter } from './adapters/evmHyp.js';
import { hasOnlyHyperlaneConnections } from './adapters/hypTokenAdapterUtils.js';
import { createRadixHypAdapter } from './adapters/radixHyp.js';
import { createSealevelHypAdapter } from './adapters/sealevelHyp.js';
import { createStarknetHypAdapter } from './adapters/starknetHyp.js';
import { createTronHypAdapter } from './adapters/tronHyp.js';

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
    const { standard, chainName, addressOrDenom } = this;

    assert(!this.isNft(), 'NFT adapters not yet supported');
    assert(
      multiProvider.tryGetChainMetadata(chainName),
      `Token chain ${chainName} not found in multiProvider`,
    );

    if (standard === TokenStandard.ERC20 || standard === TokenStandard.TRC20) {
      return new EvmTokenAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmNative ||
      standard === TokenStandard.TronNative
    ) {
      return new EvmNativeTokenAdapter(chainName, multiProvider, {});
    } else if (
      standard === TokenStandard.SealevelSpl ||
      standard === TokenStandard.SealevelSpl2022
    ) {
      return new SealevelTokenAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.SealevelNative) {
      return new SealevelNativeTokenAdapter(chainName, multiProvider, {});
    } else if (standard === TokenStandard.CosmosIcs20) {
      throw new Error('Cosmos ICS20 token adapter not yet supported');
    } else if (standard === TokenStandard.CosmosNative) {
      return new CosmNativeTokenAdapter(
        chainName,
        multiProvider,
        {},
        { ibcDenom: addressOrDenom },
      );
    } else if (standard === TokenStandard.CW20) {
      return new CwTokenAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.CWNative) {
      return new CwNativeTokenAdapter(
        chainName,
        multiProvider,
        {},
        addressOrDenom,
      );
    } else if (standard === TokenStandard.StarknetNative) {
      return new StarknetTokenAdapter(chainName, multiProvider, {
        tokenAddress: addressOrDenom,
      });
    } else if (standard === TokenStandard.RadixNative) {
      return new RadixNativeTokenAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.AleoNative) {
      return new AleoNativeTokenAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (this.isHypToken()) {
      return this.getHypAdapter(multiProvider);
    } else if (this.isIbcToken()) {
      // Passing in a stub connection here because it's not required
      // for an IBC adapter to fulfill the ITokenAdapter interface
      return this.getIbcAdapter(multiProvider, {
        token: this,
        sourcePort: 'transfer',
        sourceChannel: 'channel-0',
        type: TokenConnectionType.Ibc,
      });
    } else {
      throw new Error(`No adapter found for token standard: ${standard}`);
    }
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
    const { standard, chainName, addressOrDenom, collateralAddressOrDenom } =
      this;
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

    const hypAdapter =
      createEvmHypAdapter(multiProvider, this) ||
      createTronHypAdapter(multiProvider, this) ||
      createSealevelHypAdapter(multiProvider, this) ||
      createCosmosHypAdapter(multiProvider, this) ||
      createStarknetHypAdapter(multiProvider, this) ||
      createRadixHypAdapter(multiProvider, this) ||
      createAleoHypAdapter(multiProvider, this);

    if (hypAdapter) {
      return hypAdapter;
    } else if (standard === TokenStandard.CosmosIbc) {
      assert(destination, 'destination required for IBC token adapters');
      const connection = this.getConnectionForChain(destination);
      assert(connection, `No connection found for chain ${destination}`);
      return this.getIbcAdapter(multiProvider, connection);
    } else if (
      standard === TokenStandard.EvmM0PortalLite ||
      standard === TokenStandard.TronM0PortalLite
    ) {
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom (mToken address) required for M0PortalLite',
      );
      return new M0PortalLiteTokenAdapter(
        multiProvider,
        chainName,
        addressOrDenom, // portal address
        collateralAddressOrDenom, // mToken address
      );
    } else if (standard === TokenStandard.EvmM0Portal) {
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom (mToken address) required for M0Portal',
      );
      return new M0PortalTokenAdapter(
        multiProvider,
        chainName,
        addressOrDenom, // portal address
        collateralAddressOrDenom, // mToken address
      );
    } else {
      throw new Error(`No hyp adapter found for token standard: ${standard}`);
    }
  }

  protected getIbcAdapter(
    multiProvider: MultiProviderAdapter,
    connection: TokenConnection,
  ): IHypTokenAdapter<MsgTransferEncodeObject> {
    if (connection.type === TokenConnectionType.Ibc) {
      const { sourcePort, sourceChannel } = connection;
      return new CosmIbcTokenAdapter(
        this.chainName,
        multiProvider,
        {},
        { ibcDenom: this.addressOrDenom, sourcePort, sourceChannel },
      );
    } else if (connection.type === TokenConnectionType.IbcHyperlane) {
      const {
        sourcePort,
        sourceChannel,
        intermediateChainName,
        intermediateIbcDenom,
        intermediateRouterAddress,
      } = connection;
      const destinationRouterAddress = connection.token.addressOrDenom;
      return new CosmIbcToWarpTokenAdapter(
        this.chainName,
        multiProvider,
        {
          intermediateRouterAddress,
          destinationRouterAddress,
        },
        {
          ibcDenom: this.addressOrDenom,
          sourcePort,
          sourceChannel,
          intermediateIbcDenom,
          intermediateChainName,
        },
      );
    } else {
      throw new Error(`Unsupported IBC connection type: ${connection.type}`);
    }
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

  // ERC20s
  if (isEVMLike(protocolType)) {
    return new EvmTokenAdapter(chainName, multiProvider, {
      token: tokenAddress,
    });
  }
  // SPL and SPL2022
  else if (protocolType === ProtocolType.Sealevel) {
    return new SealevelTokenAdapter(chainName, multiProvider, {
      token: tokenAddress,
    });
  } else if (protocolType === ProtocolType.Starknet) {
    return new StarknetTokenAdapter(chainName, multiProvider, {
      tokenAddress,
    });
  } else if (protocolType === ProtocolType.Radix) {
    return new RadixTokenAdapter(chainName, multiProvider, {
      token: tokenAddress,
    });
  } else {
    throw new Error(
      `Unsupported protocol ${protocolType} for retrieving collateral token adapter on chain ${chainName}`,
    );
  }
}
