import { MsgSendEncodeObject, MsgTransferEncodeObject } from '@cosmjs/stargate';

import { MsgRemoteTransferEncodeObject } from '@hyperlane-xyz/cosmos-sdk';
import { Address, Domain, assert } from '@hyperlane-xyz/utils';

import { BaseCosmosAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import { CwHypCollateralAdapter } from './CosmWasmTokenAdapter.js';
import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

// Interacts with native tokens on a Cosmos chain (e.g TIA on Celestia)
export class CosmNativeTokenAdapter
  extends BaseCosmosAdapter
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
    const coin = await provider.getBalance(address, denom);
    return BigInt(coin.amount);
  }

  getMetadata(): Promise<TokenMetadata> {
    throw new Error('Metadata not available to native tokens');
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

  async populateTransferTx(
    transferParams: TransferParams,
  ): Promise<MsgSendEncodeObject> {
    const denom = await this.getDenom();
    return {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
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

export class CosmHypCollateralAdapter
  extends CosmNativeTokenAdapter
  implements
    IHypTokenAdapter<MsgSendEncodeObject | MsgRemoteTransferEncodeObject>
{
  protected tokenId: string;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses, { denom: '' });
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
      addressOrDenom: this.tokenId,
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

    const { igp } = await provider.query.postDispatch.Igp({
      id: params.interchainGas.addressOrDenom!,
    });

    if (!igp) {
      throw new Error(
        `Failed to find IGP for address: ${params.interchainGas.addressOrDenom}`,
      );
    }

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

    const msg: MsgRemoteTransferEncodeObject = {
      typeUrl: '/hyperlane.warp.v1.MsgRemoteTransfer',
      value: {
        sender: params.fromAccountOwner,
        recipient: params.recipient,
        amount: params.weiAmountOrId.toString(),
        token_id: this.tokenId,
        destination_domain: params.destination,
        gas_limit: router.gas,
        max_fee: {
          denom: igp.denom,
          amount: params.interchainGas.amount.toString(),
        },
      },
    };
    return msg;
  }
}

export class CosmHypSyntheticAdapter extends CosmHypCollateralAdapter {
  protected async getTokenDenom(): Promise<string> {
    return `hyperlane/${this.tokenId}`;
  }
}

const COSMOS_IBC_TRANSFER_TIMEOUT = 600_000; // 10 minutes

// Interacts with native tokens on a Cosmos chain and adds support for IBC transfers
// This implements the IHypTokenAdapter interface but it's an imperfect fit as some
// methods don't apply to IBC transfers the way they do for Warp transfers
export class CosmIbcTokenAdapter
  extends BaseCosmosAdapter
  implements IHypTokenAdapter<MsgTransferEncodeObject>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
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
    super(chainName, multiProvider, addresses);
  }

  async getBalance(address: string): Promise<bigint> {
    const provider = await this.getProvider();
    const coin = await provider.getBalance(address, this.properties.ibcDenom);
    return BigInt(coin.amount);
  }

  getMetadata(): Promise<TokenMetadata> {
    throw new Error('Metadata not available to native tokens');
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  populateApproveTx(
    _transferParams: TransferParams,
  ): Promise<MsgTransferEncodeObject> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx(
    _transferParams: TransferParams,
  ): Promise<MsgTransferEncodeObject> {
    throw new Error('TODO not yet implemented');
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // Not implemented.
    return undefined;
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

  async quoteTransferRemoteGas(
    _destination: Domain,
  ): Promise<InterchainGasQuote> {
    // TODO implement IBC interchain transfer gas estimation here
    return { amount: 0n, addressOrDenom: this.properties.ibcDenom };
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

// A wrapper for the CosmIbcTokenAdapter that adds support auto-initiated warp transfers
// A.k.a. 'One-Click' cosmos to evm transfers
export class CosmIbcToWarpTokenAdapter
  extends CosmIbcTokenAdapter
  implements IHypTokenAdapter<MsgTransferEncodeObject>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      intermediateRouterAddress: Address;
      destinationRouterAddress: Address;
    },
    public readonly properties: CosmIbcTokenAdapter['properties'] & {
      intermediateIbcDenom: string;
      intermediateChainName: ChainName;
    },
  ) {
    super(chainName, multiProvider, addresses, properties);
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
  ): Promise<InterchainGasQuote> {
    // TODO implement IBC interchain transfer gas estimation here
    return { amount: 0n, addressOrDenom: this.properties.intermediateIbcDenom };
  }

  async populateTransferRemoteTx(
    transferParams: TransferRemoteParams,
  ): Promise<MsgTransferEncodeObject> {
    const cwAdapter = new CwHypCollateralAdapter(
      this.properties.intermediateChainName,
      this.multiProvider,
      {
        token: this.properties.intermediateIbcDenom,
        warpRouter: this.addresses.intermediateRouterAddress,
      },
    );
    assert(
      transferParams.interchainGas?.addressOrDenom === this.properties.ibcDenom,
      'Only same-denom interchain gas is supported for IBC to Warp transfers',
    );
    // This transformation is necessary to ensure the CW adapter recognizes the gas
    // denom is the same as this adapter's denom (e.g. utia & igp/77...)
    const intermediateInterchainGas = {
      addressOrDenom: this.properties.intermediateIbcDenom,
      amount: transferParams.interchainGas?.amount || 0n,
    };
    const transfer = await cwAdapter.populateTransferRemoteTx({
      ...transferParams,
      interchainGas: intermediateInterchainGas,
    });
    const cwMemo = {
      wasm: {
        contract: transfer.contractAddress,
        msg: transfer.msg,
        funds: transfer.funds,
      },
    };
    const memo = JSON.stringify(cwMemo);
    if (transfer.funds?.length !== 1) {
      // Only transfers where the interchain gas denom matches the token are currently supported
      throw new Error('Expected exactly one denom for IBC to Warp transfer');
    }
    // Grab amount from the funds details which accounts for interchain gas
    const weiAmountOrId = transfer.funds[0].amount;
    return super.populateTransferRemoteTx(
      {
        ...transferParams,
        weiAmountOrId,
        recipient: this.addresses.intermediateRouterAddress,
      },
      memo,
    );
  }
}
