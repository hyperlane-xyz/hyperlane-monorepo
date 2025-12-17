import { type MsgSendEncodeObject } from '@cosmjs/stargate';

import { type MsgRemoteTransferEncodeObject } from '@hyperlane-xyz/cosmos-sdk';
import {
  type Address,
  type Domain,
  ProtocolType,
  addressToBytes32,
  assert,
  convertToProtocolAddress,
  isAddressCosmos,
} from '@hyperlane-xyz/utils';

import { BaseCosmNativeAdapter } from '../../app/MultiProtocolApp.js';
import { type MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { type ChainName } from '../../types.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../nativeTokenMetadata.js';
import { type TokenMetadata } from '../types.js';

import {
  type IHypTokenAdapter,
  type ITokenAdapter,
  type InterchainGasQuote,
  type QuoteTransferRemoteParams,
  type TransferParams,
  type TransferRemoteParams,
} from './ITokenAdapter.js';

class CosmosModuleTokenAdapter
  extends BaseCosmNativeAdapter
  implements ITokenAdapter<MsgSendEncodeObject>
{
  // use getter so Tokens which extend this base class
  // can overwrite this denom
  protected async getDenom(): Promise<string> {
    return this.properties.denom;
  }

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: Record<string, Address>,
    public readonly properties: {
      denom: string;
    },
  ) {
    if (!properties.denom) {
      throw new Error('Missing properties for CosmNativeTokenAdapter');
    }

    super(chainName, multiProvider, addresses);
  }

  async getBalance(address: string): Promise<bigint> {
    const provider = await this.getProvider();
    const denom = await this.getDenom();

    // if the address is a cosmos address we can simply read the account balance
    // of that address. The address can also be an ETH address format indicating
    // that the balance of a Hyp Token Contract should be returned. In this case
    // we get the token by it's id and return the bridged supply which equals the
    // balance the token has.
    if (isAddressCosmos(address)) {
      return provider.getBalance({
        address,
        denom,
      });
    } else {
      return provider.getBridgedSupply({ tokenAddress: address });
    }
  }

  async getMetadata(): Promise<TokenMetadata> {
    const token = await this.multiProvider.getNativeToken(this.chainName);

    return {
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
    };
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  populateApproveTx(
    _transferParams: TransferParams,
  ): Promise<MsgSendEncodeObject> {
    throw new Error('Approve not required for native tokens');
  }

  async isRevokeApprovalRequired(_: Address, __: Address): Promise<boolean> {
    return false;
  }

  async populateTransferTx(
    transferParams: TransferParams,
  ): Promise<MsgSendEncodeObject> {
    const provider = await this.getProvider();
    const denom = await this.getDenom();

    assert(transferParams.fromAccountOwner, `no sender in transfer params`);

    return provider.getTransferTransaction({
      signer: transferParams.fromAccountOwner,
      recipient: transferParams.recipient,
      denom,
      amount: transferParams.weiAmountOrId.toString(),
    });
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const provider = await this.getProvider();
    const denom = await this.getDenom();
    return provider.getTotalSupply({ denom });
  }
}

export class CosmNativeHypCollateralAdapter
  extends CosmosModuleTokenAdapter
  implements
    IHypTokenAdapter<MsgSendEncodeObject | MsgRemoteTransferEncodeObject>
{
  protected tokenAddress: string;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses, {
      denom: PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[ProtocolType.CosmosNative].denom!,
    });
    this.tokenAddress = addresses.token;
  }

  protected async getDenom(): Promise<string> {
    const provider = await this.getProvider();
    const { denom } = await provider.getToken({
      tokenAddress: this.tokenAddress,
    });

    return denom;
  }

  async getDomains(): Promise<Domain[]> {
    const provider = await this.getProvider();
    const remoteRouters = await provider.getRemoteRouters({
      tokenAddress: this.tokenAddress,
    });

    return remoteRouters.remoteRouters.map((router) => router.receiverDomainId);
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const provider = await this.getProvider();
    const remoteRouters = await provider.getRemoteRouters({
      tokenAddress: this.tokenAddress,
    });

    const router = remoteRouters.remoteRouters.find(
      (router) => router.receiverDomainId === domain,
    );

    if (!router) {
      throw new Error(`Router with domain "${domain}" not found`);
    }

    return Buffer.from(router.receiverAddress);
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const provider = await this.getProvider();
    const remoteRouters = await provider.getRemoteRouters({
      tokenAddress: this.tokenAddress,
    });

    return remoteRouters.remoteRouters.map((router) => ({
      domain: router.receiverDomainId,
      address: Buffer.from(router.receiverAddress),
    }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    const provider = await this.getProvider();
    return await provider.getBridgedSupply({
      tokenAddress: this.tokenAddress,
    });
  }

  async quoteTransferRemoteGas({
    destination,
    customHook,
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    const provider = await this.getProvider();
    const { denom: addressOrDenom, amount } =
      await provider.quoteRemoteTransfer({
        tokenAddress: this.tokenAddress,
        destinationDomainId: destination,
        customHookAddress: customHook,
      });

    return {
      igpQuote: {
        addressOrDenom,
        amount,
      },
    };
  }

  async populateTransferRemoteTx(
    params: TransferRemoteParams,
  ): Promise<MsgRemoteTransferEncodeObject> {
    if (!params.interchainGas) {
      params.interchainGas = await this.quoteTransferRemoteGas({
        destination: params.destination,
        customHook: params.customHook,
      });
    }

    const provider = await this.getProvider();

    const { remoteRouters } = await provider.getRemoteRouters({
      tokenAddress: this.tokenAddress,
    });

    const router = remoteRouters.find(
      (router) => router.receiverDomainId === params.destination,
    );

    if (!router) {
      throw new Error(
        `Failed to find remote router for token id and destination: ${this.tokenAddress},${params.destination}`,
      );
    }

    const { igpQuote } = params.interchainGas;
    if (!igpQuote.addressOrDenom) {
      throw new Error(
        `Require denom for max fee, didn't receive and denom in the interchainGas quote`,
      );
    }

    const destinationMetadata = this.multiProvider.getChainMetadata(
      params.destination,
    );
    const destinationProtocol = destinationMetadata.protocol;

    return provider.getRemoteTransferTransaction({
      signer: params.fromAccountOwner!,
      tokenAddress: this.tokenAddress,
      destinationDomainId: params.destination,
      recipient: addressToBytes32(
        convertToProtocolAddress(
          params.recipient,
          destinationMetadata.protocol,
          destinationMetadata.bech32Prefix,
        ),
        destinationProtocol,
      ),
      amount: params.weiAmountOrId.toString(),
      customHookAddress: params.customHook,
      gasLimit: router.gas,
      maxFee: {
        denom: igpQuote.addressOrDenom || '',
        amount: igpQuote.amount.toString(),
      },
    });
  }
}

export class CosmNativeHypSyntheticAdapter extends CosmNativeHypCollateralAdapter {
  protected async getTokenDenom(): Promise<string> {
    return `hyperlane/${this.tokenAddress}`;
  }
}
