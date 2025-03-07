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

export class CosmosModuleTokenAdapter
  extends BaseCosmosModuleAdapter
  implements ITokenAdapter<MsgRemoteTransferEncodeObject>
{
  protected denom: string;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.denom = `hyperlane/${addresses.token}`;
  }

  async getBalance(address: string): Promise<bigint> {
    const provider = await this.getProvider();
    const balance = await provider.getBalance(address, this.denom);
    return BigInt(balance.amount);
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // TODO: implement
    return 0n;
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
}

export class CosmosModuleHypSyntheticAdapter
  extends CosmosModuleTokenAdapter
  implements IHypTokenAdapter<MsgRemoteTransferEncodeObject>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async getDomains(): Promise<Domain[]> {
    // TODO: implement
    return [];
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
    _sender?: Address,
  ): Promise<InterchainGasQuote> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
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

export class CosmosModuleHypCollateralAdapter
  extends CosmosModuleTokenAdapter
  implements IHypTokenAdapter<MsgRemoteTransferEncodeObject>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async getDomains(): Promise<Domain[]> {
    // TODO: implement
    return [];
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
    _sender?: Address,
  ): Promise<InterchainGasQuote> {
    // TODO: implement
    throw new Error('Method not implemented yet.');
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
