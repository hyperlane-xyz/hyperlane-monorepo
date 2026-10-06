import { MsgSendEncodeObject, MsgTransferEncodeObject } from '@cosmjs/stargate';

import { Address, Domain, assert } from '@hyperlane-xyz/utils';

import { BaseCosmosAdapter } from '../../app/MultiProtocolApp.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  QuoteTransferRemoteParams,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

const COSMOS_IBC_TRANSFER_TIMEOUT = 600_000; // 10 minutes

// Interacts with native tokens on a Cosmos chain (e.g TIA on Celestia)
export class CosmNativeTokenAdapter
  extends BaseCosmosAdapter
  implements ITokenAdapter<MsgTransferEncodeObject | MsgSendEncodeObject>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProviderAdapter,
    public readonly addresses: Record<string, Address>,
    public readonly properties: {
      ibcDenom: string;
    },
  ) {
    if (!properties.ibcDenom)
      throw new Error('Missing properties for CosmNativeTokenAdapter');
    super(chainName, multiProvider, addresses);
  }

  async getBalance(address: string): Promise<bigint> {
    const provider = await this.getProvider();
    const coin = await provider.getBalance(address, this.properties.ibcDenom);
    return BigInt(coin.amount);
  }

  async getMetadata(): Promise<TokenMetadata> {
    const { nativeToken } = this.multiProvider.getChainMetadata(this.chainName);
    assert(
      nativeToken,
      `Native token data is required for ${CosmNativeTokenAdapter.name}`,
    );

    return {
      name: nativeToken.name,
      symbol: nativeToken.symbol,
      decimals: nativeToken.decimals,
    };
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
  }

  populateApproveTx(
    _transferParams: TransferParams,
  ): Promise<MsgTransferEncodeObject> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx(
    transferParams: TransferParams,
  ): Promise<MsgSendEncodeObject | MsgTransferEncodeObject> {
    return {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: transferParams.fromAccountOwner,
        toAddress: transferParams.recipient,
        amount: [
          {
            amount: transferParams.weiAmountOrId.toString(),
            denom: this.properties.ibcDenom,
          },
        ],
      },
    };
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // Not implemented.
    return undefined;
  }
}

// Interacts with native tokens on a Cosmos chain and adds support for IBC transfers
// This implements the IHypTokenAdapter interface but it's an imperfect fit as some
// methods don't apply to IBC transfers the way they do for Warp transfers
export class CosmIbcTokenAdapter
  extends CosmNativeTokenAdapter
  implements IHypTokenAdapter<MsgTransferEncodeObject>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProviderAdapter,
    public readonly addresses: Record<string, Address>,
    public readonly properties: {
      ibcDenom: string;
      sourcePort: string;
      sourceChannel: string;
    },
  ) {
    if (
      !properties.ibcDenom ||
      !properties.sourcePort ||
      !properties.sourceChannel
    )
      throw new Error('Missing properties for CosmNativeIbcTokenAdapter');
    super(chainName, multiProvider, addresses, properties);
  }

  getDomains(): Promise<Domain[]> {
    throw new Error('Method not applicable to IBC adapters');
  }
  getRouterAddress(_domain: Domain): Promise<Buffer> {
    throw new Error('Method not applicable to IBC adapters');
  }
  getAllRouters(): Promise<
    Array<{
      domain: Domain;
      address: Buffer;
    }>
  > {
    throw new Error('Method not applicable to IBC adapters');
  }

  getBridgedSupply(): Promise<bigint | undefined> {
    throw new Error('Method not applicable to IBC adapters');
  }

  async quoteTransferRemoteGas({
    destination: _destination,
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    // TODO implement IBC interchain transfer gas estimation here
    return {
      igpQuote: { amount: 0n, addressOrDenom: this.properties.ibcDenom },
    };
  }

  getMetadata(): Promise<TokenMetadata> {
    throw new Error('Metadata not available to native tokens');
  }

  override async populateTransferTx(
    _transferParams: TransferParams,
  ): Promise<MsgTransferEncodeObject> {
    throw new Error('TODO not yet implemented');
  }

  async populateTransferRemoteTx(
    transferParams: TransferRemoteParams,
    memo = '',
  ): Promise<MsgTransferEncodeObject> {
    if (!transferParams.fromAccountOwner)
      throw new Error('fromAccountOwner is required for ibc transfers');

    const value = {
      sourcePort: this.properties.sourcePort,
      sourceChannel: this.properties.sourceChannel,
      token: {
        denom: this.properties.ibcDenom,
        amount: transferParams.weiAmountOrId.toString(),
      },
      sender: transferParams.fromAccountOwner,
      receiver: transferParams.recipient,
      // Represented as nano-seconds
      timeoutTimestamp:
        BigInt(new Date().getTime() + COSMOS_IBC_TRANSFER_TIMEOUT) * 1000000n,
      memo,
    };
    return {
      typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
      value,
    };
  }
}
