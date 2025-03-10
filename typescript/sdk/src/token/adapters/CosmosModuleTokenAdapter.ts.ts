import { MsgRemoteTransferEncodeObject } from 'hyperlane-cosmos-sdk';

import { Address, Domain, Numberish } from '@hyperlane-xyz/utils';

import { BaseCosmosModuleAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

export class CosmosModuleHypSyntheticAdapter
  extends BaseCosmosModuleAdapter
  implements
    ITokenAdapter<MsgRemoteTransferEncodeObject>,
    IHypTokenAdapter<MsgRemoteTransferEncodeObject>
{
  protected tokenId: string;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.tokenId = addresses.token;
  }

  protected async getTokenDenom(): Promise<string> {
    return `hyperlane/${this.tokenId}`;
  }

  async getBalance(address: string): Promise<bigint> {
    const provider = await this.getProvider();
    const denom = await this.getTokenDenom();
    const balance = await provider.getBalance(address, denom);
    return BigInt(balance.amount);
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const provider = await this.getProvider();
    const denom = await this.getTokenDenom();
    const supply = await provider
      .getHyperlaneQueryClient()!
      .bank.supplyOf(denom);
    return BigInt(supply.amount);
  }

  getMetadata(): Promise<TokenMetadata> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(
    _owner: Address,
    _spender: Address,
    _weiAmountOrId: Numberish,
  ): Promise<boolean> {
    return false;
  }

  async populateApproveTx(
    params: TransferParams,
  ): Promise<MsgRemoteTransferEncodeObject> {
    const msg: MsgRemoteTransferEncodeObject = {
      typeUrl: '/hyperlane.warp.v1.MsgRemoteTransfer',
      value: {
        sender: params.fromTokenAccount,
        recipient: params.recipient,
        amount: params.weiAmountOrId.toString(),
      },
    };
    return msg;
  }

  async populateTransferTx(
    params: TransferParams,
  ): Promise<MsgRemoteTransferEncodeObject> {
    const msg: MsgRemoteTransferEncodeObject = {
      typeUrl: '/hyperlane.warp.v1.MsgRemoteTransfer',
      value: {
        sender: params.fromTokenAccount,
        recipient: params.recipient,
        amount: params.weiAmountOrId.toString(),
      },
    };
    return msg;
  }

  async getDomains(): Promise<Domain[]> {
    const provider = await this.getProvider();
    const remoteRouters = await provider
      .getHyperlaneQueryClient()!
      .warp.RemoteRouters({ id: this.tokenId });

    return remoteRouters.remote_routers.map((router) => router.receiver_domain);
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const provider = await this.getProvider();
    const remoteRouters = await provider
      .getHyperlaneQueryClient()!
      .warp.RemoteRouters({ id: this.tokenId });

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
    const remoteRouters = await provider
      .getHyperlaneQueryClient()!
      .warp.RemoteRouters({ id: this.tokenId });

    return remoteRouters.remote_routers.map((router) => ({
      domain: router.receiver_domain,
      address: Buffer.from(router.receiver_contract),
    }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    const provider = await this.getProvider();
    const { bridged_supply } = await provider
      .getHyperlaneQueryClient()!
      .warp.BridgedSupply({ id: this.tokenId });

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
    const { gas_payment } = await provider
      .getHyperlaneQueryClient()!
      .warp.QuoteRemoteTransfer({
        id: this.tokenId,
        destination_domain: destination.toString(),
      });

    return {
      addressOrDenom: this.tokenId,
      amount: BigInt(gas_payment[0].amount),
    };
  }

  async populateTransferRemoteTx(
    params: TransferRemoteParams,
  ): Promise<MsgRemoteTransferEncodeObject> {
    const msg: MsgRemoteTransferEncodeObject = {
      typeUrl: '/hyperlane.warp.v1.MsgRemoteTransfer',
      value: {
        sender: params.fromTokenAccount,
        recipient: params.recipient,
        amount: params.weiAmountOrId.toString(),
      },
    };
    return msg;
  }
}

export class CosmosModuleHypCollateralAdapter extends CosmosModuleHypSyntheticAdapter {
  protected async getTokenDenom(): Promise<string> {
    const provider = await this.getProvider();
    const { token } = await provider
      .getHyperlaneQueryClient()!
      .warp.Token({ id: this.tokenId });

    return token?.origin_denom ?? '';
  }

  // TODO: can we take bridged supply for both synthetic and collateral?
}
