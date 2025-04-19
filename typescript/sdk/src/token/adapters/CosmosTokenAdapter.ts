import { MsgTransferEncodeObject } from '@cosmjs/stargate';

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

const COSMOS_IBC_TRANSFER_TIMEOUT = 600_000; // 10 minutes

// Interacts with native tokens on a Cosmos chain (e.g TIA on Celestia)
export class CosmNativeTokenAdapter
  extends BaseCosmosAdapter
  implements ITokenAdapter<MsgTransferEncodeObject>
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
    _transferParams: TransferParams,
  ): Promise<MsgTransferEncodeObject> {
    throw new Error('TODO not yet implemented');
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
