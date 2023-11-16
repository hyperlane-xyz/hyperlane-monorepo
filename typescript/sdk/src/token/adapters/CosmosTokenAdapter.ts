import { MsgTransferEncodeObject } from '@cosmjs/stargate';
import Long from 'long';

import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseCosmosAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ChainName } from '../../types';
import { MinimalTokenMetadata } from '../config';

import { CwHypCollateralAdapter } from './CosmWasmTokenAdapter';
import {
  IHypTokenAdapter,
  ITokenAdapter,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter';

const COSMOS_IBC_TRANSFER_TIMEOUT = 600_000; // 10 minutes

// Interacts with native tokens on a Cosmos chain (e.g TIA on Celestia)
export class CosmNativeTokenAdapter
  extends BaseCosmosAdapter
  implements ITokenAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: Record<string, Address>,
    public readonly properties: {
      ibcDenom: string;
    },
  ) {
    if (!properties.ibcDenom)
      throw new Error('Missing properties for CosmNativeTokenAdapter');
    super(chainName, multiProvider, addresses);
  }

  async getBalance(address: string): Promise<string> {
    const provider = await this.getProvider();
    const coin = await provider.getBalance(address, this.properties.ibcDenom);
    return coin.amount;
  }

  getMetadata(): Promise<MinimalTokenMetadata> {
    throw new Error('Metadata not available to native tokens');
  }

  populateApproveTx(_transferParams: TransferParams): unknown {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx(
    _transferParams: TransferParams,
  ): Promise<MsgTransferEncodeObject> {
    throw new Error('TODO not yet implemented');
  }
}

// Interacts with native tokens on a Cosmos chain and adds support for IBC transfers
// This implements the IHypTokenAdapter interface but it's an imperfect fit as some
// methods don't apply to IBC transfers the way they do for Warp transfers
export class CosmIbcTokenAdapter
  extends CosmNativeTokenAdapter
  implements IHypTokenAdapter
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
  quoteGasPayment(_destination: Domain): Promise<string> {
    throw new Error('Method not applicable to IBC adapters');
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
      timeoutTimestamp: Long.fromNumber(
        new Date().getTime() + COSMOS_IBC_TRANSFER_TIMEOUT,
      ).multiply(1_000_000),
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
  implements IHypTokenAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      intermediateRouterAddress: Address;
      destinationRouterAddress: Address;
    },
    public readonly properties: CosmIbcTokenAdapter['properties'] & {
      derivedIbcDenom: string;
      intermediateChainName: ChainName;
    },
  ) {
    super(chainName, multiProvider, addresses, properties);
  }

  async populateTransferRemoteTx(
    transferParams: TransferRemoteParams,
  ): Promise<MsgTransferEncodeObject> {
    const cwAdapter = new CwHypCollateralAdapter(
      this.properties.intermediateChainName,
      this.multiProvider,
      {
        token: this.properties.derivedIbcDenom,
        warpRouter: this.addresses.intermediateRouterAddress,
      },
      this.properties.derivedIbcDenom,
    );
    const transfer = await cwAdapter.populateTransferRemoteTx(transferParams);
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
