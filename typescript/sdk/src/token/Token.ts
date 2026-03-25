import { MsgTransferEncodeObject } from '@cosmjs/stargate';

import {
  Address,
  Numberish,
  ProtocolType,
  assert,
  isEVMLike,
} from '@hyperlane-xyz/utils';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '../providers/ConfiguredMultiProtocolProvider.js';
import { ChainName } from '../types.js';
import { isStarknetFeeToken } from '../utils/starknet.js';

import type { IToken, TokenArgs } from './IToken.js';
import { TokenAmount } from './TokenAmount.js';
import { TokenConnection, TokenConnectionType } from './TokenConnection.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenMetadata } from './TokenMetadata.js';
import {
  AleoHypCollateralAdapter,
  AleoHypNativeAdapter,
  AleoHypSyntheticAdapter,
  AleoNativeTokenAdapter,
} from './adapters/AleoTokenAdapter.js';
import {
  CwHypCollateralAdapter,
  CwHypNativeAdapter,
  CwHypSyntheticAdapter,
  CwNativeTokenAdapter,
  CwTokenAdapter,
} from './adapters/CosmWasmTokenAdapter.js';
import {
  CosmNativeHypCollateralAdapter,
  CosmNativeHypSyntheticAdapter,
} from './adapters/CosmosModuleTokenAdapter.js';
import {
  CosmIbcToWarpTokenAdapter,
  CosmIbcTokenAdapter,
  CosmNativeTokenAdapter,
} from './adapters/CosmosTokenAdapter.js';
import { EvmHypCrossCollateralAdapter } from './adapters/EvmCrossCollateralAdapter.js';
import {
  EvmHypCollateralFiatAdapter,
  EvmHypNativeAdapter,
  EvmHypRebaseCollateralAdapter,
  EvmHypSyntheticAdapter,
  EvmHypSyntheticRebaseAdapter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  EvmMovableCollateralAdapter,
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
  RadixHypCollateralAdapter,
  RadixHypSyntheticAdapter,
  RadixNativeTokenAdapter,
  RadixTokenAdapter,
} from './adapters/RadixTokenAdapter.js';
import { SealevelHypCrossCollateralAdapter } from './adapters/SealevelCrossCollateralAdapter.js';
import {
  SealevelHypCollateralAdapter,
  SealevelHypNativeAdapter,
  SealevelHypSyntheticAdapter,
  SealevelNativeTokenAdapter,
  SealevelTokenAdapter,
} from './adapters/SealevelTokenAdapter.js';
import {
  StarknetHypCollateralAdapter,
  StarknetHypFeeAdapter,
  StarknetHypNativeAdapter,
  StarknetHypSyntheticAdapter,
  StarknetTokenAdapter,
} from './adapters/StarknetTokenAdapter.js';

// Declaring the interface in addition to class allows
// Typescript to infer the members vars from TokenArgs
export interface Token extends TokenArgs {}

export class Token extends TokenMetadata implements IToken {
  override amount(amount: Numberish): TokenAmount<this> {
    return new TokenAmount(amount, this);
  }

  override getConnections(): TokenConnection<IToken>[] {
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
    const index = this.connections?.findIndex((t) => t.token.equals(token));
    if (index && index >= 0) this.connections?.splice(index, 1);
    return this;
  }

  /**
   * Returns a TokenAdapter for the token and multiProvider
   * @throws If multiProvider does not contain this token's chain.
   * @throws If token is an NFT (TODO NFT Adapter support)
   */
  getAdapter(multiProvider: MultiProtocolProvider): ITokenAdapter<unknown> {
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
    multiProvider: MultiProtocolProvider<{ mailbox?: Address }>,
    destination?: ChainName,
  ): IHypTokenAdapter<unknown> {
    const { standard, chainName, addressOrDenom, collateralAddressOrDenom } =
      this;
    const chainMetadata = multiProvider.tryGetChainMetadata(chainName);
    const mailbox = chainMetadata?.mailbox;

    if (
      standard === TokenStandard.EvmNative &&
      this.connections?.length &&
      this.connections.every(
        (c) => !c.type || c.type === TokenConnectionType.Hyperlane,
      )
    ) {
      assert(
        chainMetadata,
        `Token chain ${chainName} not found in multiProvider`,
      );
      return new EvmHypNativeAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    }

    assert(
      this.isMultiChainToken(),
      `Token standard ${standard} not applicable to hyp adapter`,
    );
    assert(!this.isNft(), 'NFT adapters not yet supported');
    assert(
      chainMetadata,
      `Token chain ${chainName} not found in multiProvider`,
    );

    if (
      standard === TokenStandard.EvmHypNative ||
      standard === TokenStandard.TronHypNative
    ) {
      return new EvmHypNativeAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmHypCollateral ||
      standard === TokenStandard.EvmHypOwnerCollateral ||
      standard === TokenStandard.TronHypCollateral ||
      standard === TokenStandard.TronHypOwnerCollateral
    ) {
      return new EvmMovableCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmHypCrossCollateralRouter ||
      standard === TokenStandard.TronHypCrossCollateralRouter
    ) {
      return new EvmHypCrossCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmHypRebaseCollateral ||
      standard === TokenStandard.TronHypRebaseCollateral
    ) {
      return new EvmHypRebaseCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmHypCollateralFiat ||
      standard === TokenStandard.TronHypCollateralFiat
    ) {
      return new EvmHypCollateralFiatAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmHypSynthetic ||
      standard === TokenStandard.TronHypSynthetic
    ) {
      return new EvmHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmHypSyntheticRebase ||
      standard === TokenStandard.TronHypSyntheticRebase
    ) {
      return new EvmHypSyntheticRebaseAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmHypXERC20 ||
      standard === TokenStandard.EvmHypVSXERC20 ||
      standard === TokenStandard.TronHypXERC20 ||
      standard === TokenStandard.TronHypVSXERC20
    ) {
      return new EvmHypXERC20Adapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (
      standard === TokenStandard.EvmHypXERC20Lockbox ||
      standard === TokenStandard.EvmHypVSXERC20Lockbox ||
      standard === TokenStandard.TronHypXERC20Lockbox ||
      standard === TokenStandard.TronHypVSXERC20Lockbox
    ) {
      return new EvmHypXERC20LockboxAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.SealevelHypNative) {
      assert(mailbox, `Mailbox required for Sealevel hyp tokens`);
      return new SealevelHypNativeAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        mailbox,
      });
    } else if (standard === TokenStandard.SealevelHypCollateral) {
      assert(mailbox, `Mailbox required for Sealevel hyp tokens`);
      assert(
        collateralAddressOrDenom,
        `collateralAddressOrDenom required for Sealevel hyp collateral tokens`,
      );

      return new SealevelHypCollateralAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
        mailbox,
      });
    } else if (standard === TokenStandard.SealevelHypCrossCollateral) {
      assert(mailbox, `Mailbox required for Sealevel hyp tokens`);
      assert(
        collateralAddressOrDenom,
        `collateralAddressOrDenom required for Sealevel hyp cross-collateral tokens`,
      );

      return new SealevelHypCrossCollateralAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
        mailbox,
      });
    } else if (standard === TokenStandard.SealevelHypSynthetic) {
      assert(mailbox, `Mailbox required for Sealevel hyp tokens`);
      assert(
        collateralAddressOrDenom,
        `collateralAddressOrDenom required for Sealevel hyp collateral tokens`,
      );

      return new SealevelHypSyntheticAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
        mailbox,
      });
    } else if (standard === TokenStandard.CwHypNative) {
      return new CwHypNativeAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    } else if (standard === TokenStandard.CwHypCollateral) {
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom required for CwHypCollateral',
      );
      return new CwHypCollateralAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
      });
    } else if (standard === TokenStandard.CwHypSynthetic) {
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom required for CwHypSyntheticAdapter',
      );
      return new CwHypSyntheticAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
      });
    } else if (standard === TokenStandard.CosmosIbc) {
      assert(destination, 'destination required for IBC token adapters');
      const connection = this.getConnectionForChain(destination);
      assert(connection, `No connection found for chain ${destination}`);
      return this.getIbcAdapter(multiProvider, connection);
    } else if (standard === TokenStandard.CosmNativeHypCollateral) {
      return new CosmNativeHypCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.CosmNativeHypSynthetic) {
      return new CosmNativeHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (isStarknetFeeToken(chainName, addressOrDenom)) {
      return new StarknetHypFeeAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    } else if (standard === TokenStandard.StarknetHypNative) {
      return new StarknetHypNativeAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    } else if (standard === TokenStandard.StarknetHypSynthetic) {
      return new StarknetHypSyntheticAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    } else if (standard === TokenStandard.StarknetHypCollateral) {
      return new StarknetHypCollateralAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    } else if (standard === TokenStandard.RadixHypCollateral) {
      return new RadixHypCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.RadixHypSynthetic) {
      return new RadixHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.AleoHypNative) {
      return new AleoHypNativeAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.AleoHypCollateral) {
      return new AleoHypCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    } else if (standard === TokenStandard.AleoHypSynthetic) {
      return new AleoHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
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
    multiProvider: MultiProtocolProvider,
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
    multiProvider: MultiProtocolProvider,
    address: Address,
  ): Promise<TokenAmount<IToken>> {
    const adapter = this.getAdapter(multiProvider);
    const balance = await adapter.getBalance(address);
    return new TokenAmount(balance, this);
  }
  }

interface GetCollateralTokenAdapterOptions {
  multiProvider: MultiProtocolProvider;
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
