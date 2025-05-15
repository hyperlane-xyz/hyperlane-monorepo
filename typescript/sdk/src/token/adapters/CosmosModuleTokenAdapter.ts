import { MsgSendEncodeObject } from '@cosmjs/stargate';

import { MsgRemoteTransferEncodeObject } from '@hyperlane-xyz/cosmos-sdk';
import {
  Address,
  Domain,
  ProtocolType,
  addressToBytes32,
  convertToProtocolAddress,
  isAddressCosmos,
} from '@hyperlane-xyz/utils';

import { BaseCosmNativeAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../nativeTokenMetadata.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

const COSMOS_TYPE_URL_SEND = '/cosmos.bank.v1beta1.MsgSend';

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
      const coin = await provider.getBalance(address, denom);
      return BigInt(coin.amount);
    } else {
      const { bridged_supply } = await provider.query.warp.BridgedSupply({
        id: address,
      });
      return BigInt(bridged_supply?.amount ?? '0');
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
    const denom = await this.getDenom();
    return {
      typeUrl: COSMOS_TYPE_URL_SEND,
      value: {
        fromAddress: transferParams.fromAccountOwner,
        toAddress: transferParams.recipient,
        amount: [
          {
            denom,
            amount: transferParams.weiAmountOrId.toString(),
          },
        ],
      },
    };
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const provider = await this.getProvider();
    const denom = await this.getDenom();
    const supply = await provider.query.bank.supplyOf(denom);
    return BigInt(supply.amount);
  }
}

export class CosmNativeHypCollateralAdapter
  extends CosmosModuleTokenAdapter
  implements
    IHypTokenAdapter<MsgSendEncodeObject | MsgRemoteTransferEncodeObject>
{
  protected tokenId: string;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses, {
      denom: PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[ProtocolType.CosmosNative].denom!,
    });
    this.tokenId = addresses.token;
  }

  protected async getDenom(): Promise<string> {
    const provider = await this.getProvider();
    const { token } = await provider.query.warp.Token({ id: this.tokenId });

    return token?.origin_denom ?? '';
  }

  async getDomains(): Promise<Domain[]> {
    const provider = await this.getProvider();
    const remoteRouters = await provider.query.warp.RemoteRouters({
      id: this.tokenId,
    });

    return remoteRouters.remote_routers.map((router) => router.receiver_domain);
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const provider = await this.getProvider();
    const remoteRouters = await provider.query.warp.RemoteRouters({
      id: this.tokenId,
    });

    const router = remoteRouters.remote_routers.find(
      (router) => router.receiver_domain === domain,
    );

    if (!router) {
      throw new Error(`Router with domain "${domain}" not found`);
    }

    return Buffer.from(router.receiver_contract);
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const provider = await this.getProvider();
    const remoteRouters = await provider.query.warp.RemoteRouters({
      id: this.tokenId,
    });

    return remoteRouters.remote_routers.map((router) => ({
      domain: router.receiver_domain,
      address: Buffer.from(router.receiver_contract),
    }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    const provider = await this.getProvider();
    const { bridged_supply } = await provider.query.warp.BridgedSupply({
      id: this.tokenId,
    });

    if (!bridged_supply) {
      return undefined;
    }

    return BigInt(bridged_supply.amount);
  }

  async quoteTransferRemoteGas(
    destination: Domain,
    _sender?: Address,
  ): Promise<InterchainGasQuote> {
    const provider = await this.getProvider();
    const { gas_payment } = await provider.query.warp.QuoteRemoteTransfer({
      id: this.tokenId,
      destination_domain: destination.toString(),
    });

    return {
      addressOrDenom: gas_payment[0].denom,
      amount: BigInt(gas_payment[0].amount),
    };
  }

  async populateTransferRemoteTx(
    params: TransferRemoteParams,
  ): Promise<MsgRemoteTransferEncodeObject> {
    if (!params.interchainGas) {
      params.interchainGas = await this.quoteTransferRemoteGas(
        params.destination,
      );
    }

    const provider = await this.getProvider();

    const { remote_routers } = await provider.query.warp.RemoteRouters({
      id: this.tokenId,
    });

    const router = remote_routers.find(
      (router) => router.receiver_domain === params.destination,
    );

    if (!router) {
      throw new Error(
        `Failed to find remote router for token id and destination: ${this.tokenId},${params.destination}`,
      );
    }

    if (!params.interchainGas.addressOrDenom) {
      throw new Error(
        `Require denom for max fee, didn't receive and denom in the interchainGas quote`,
      );
    }

    const msg: MsgRemoteTransferEncodeObject = {
      typeUrl: '/hyperlane.warp.v1.MsgRemoteTransfer',
      value: {
        sender: params.fromAccountOwner,
        recipient: addressToBytes32(
          convertToProtocolAddress(params.recipient, ProtocolType.Ethereum),
          ProtocolType.Ethereum,
        ),
        amount: params.weiAmountOrId.toString(),
        token_id: this.tokenId,
        destination_domain: params.destination,
        gas_limit: router.gas,
        max_fee: {
          denom: params.interchainGas.addressOrDenom || '',
          amount: params.interchainGas.amount.toString(),
        },
      },
    };
    return msg;
  }
}

export class CosmNativeHypSyntheticAdapter extends CosmNativeHypCollateralAdapter {
  protected async getTokenDenom(): Promise<string> {
    return `hyperlane/${this.tokenId}`;
  }
}
