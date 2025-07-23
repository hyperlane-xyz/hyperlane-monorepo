import { TransactionManifest } from '@radixdlt/radix-engine-toolkit';
import { assert } from 'console';

import { RadixSDK } from '@hyperlane-xyz/radix-sdk';
import {
  Address,
  Domain,
  ProtocolType,
  addressToBytes32,
  convertToProtocolAddress,
} from '@hyperlane-xyz/utils';

import { BaseRadixAdapter } from '../../app/MultiProtocolApp.js';
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

class RadixTokenAdapter
  extends BaseRadixAdapter
  implements ITokenAdapter<TransactionManifest>
{
  protected provider: RadixSDK;
  protected tokenId: string;

  protected async getDenom(): Promise<string> {
    const { origin_denom } = await this.provider.query.getToken({
      token: this.tokenId,
    });
    return origin_denom;
  }

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.provider = this.getProvider();
    this.tokenId = addresses.token;
  }

  async getBalance(address: string): Promise<bigint> {
    const denom = await this.getDenom();

    return this.provider.query.getBalance({
      address,
      resource: denom,
    });
  }

  async getMetadata(): Promise<TokenMetadata> {
    const { name, symbol, divisibility } = await this.provider.query.getToken({
      token: this.tokenId,
    });

    assert(
      name !== undefined,
      `name on radix token ${this.tokenId} is undefined`,
    );
    assert(
      symbol !== undefined,
      `symbol on radix token ${this.tokenId} is undefined`,
    );

    return {
      name: name!,
      symbol: symbol!,
      decimals: divisibility,
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
  ): Promise<TransactionManifest> {
    throw new Error('Approve not required for native tokens');
  }

  async isRevokeApprovalRequired(_: Address, __: Address): Promise<boolean> {
    return false;
  }

  async populateTransferTx(
    transferParams: TransferParams,
  ): Promise<TransactionManifest> {
    const denom = await this.getDenom();

    assert(transferParams.fromAccountOwner, `no sender in transfer params`);

    return this.provider.populate.transfer({
      from_address: transferParams.fromAccountOwner!,
      to_address: transferParams.recipient,
      resource_address: denom,
      amount: transferParams.weiAmountOrId.toString(),
    });
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const denom = await this.getDenom();
    return this.provider.query.getTotalSupply({
      resource: denom,
    });
  }
}

export class RadixHypCollateralAdapter
  extends RadixTokenAdapter
  implements IHypTokenAdapter<TransactionManifest>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async getDomains(): Promise<Domain[]> {
    const { remote_routers } = await this.provider.query.getRemoteRouters({
      token: this.tokenId,
    });

    return remote_routers.map((router) => parseInt(router.receiver_domain));
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const { remote_routers } = await this.provider.query.getRemoteRouters({
      token: this.tokenId,
    });

    const router = remote_routers.find(
      (router) => parseInt(router.receiver_domain) === domain,
    );

    if (!router) {
      throw new Error(`Router with domain "${domain}" not found`);
    }

    return Buffer.from(router.receiver_contract);
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const { remote_routers } = await this.provider.query.getRemoteRouters({
      token: this.tokenId,
    });

    return remote_routers.map((router) => ({
      domain: parseInt(router.receiver_domain),
      address: Buffer.from(router.receiver_contract),
    }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    return this.provider.query.getBridgedSupply({ token: this.tokenId });
  }

  async quoteTransferRemoteGas(
    destination: Domain,
    _?: Address,
    customHook?: Address,
  ): Promise<InterchainGasQuote> {
    // TODO: RADIX
    // const { gas_payment } = await this.provider.query.warp.QuoteRemoteTransfer({
    //   id: this.tokenId,
    //   destination_domain: destination.toString(),
    //   custom_hook_id: customHook || COSMOS_EMPTY_VALUE,
    //   custom_hook_metadata: COSMOS_EMPTY_VALUE,
    // });

    return {
      addressOrDenom: '',
      amount: BigInt(0),
    };
  }

  async populateTransferRemoteTx(
    params: TransferRemoteParams,
  ): Promise<TransactionManifest> {
    assert(params.fromAccountOwner, `no sender in remote transfer params`);

    if (!params.interchainGas) {
      params.interchainGas = await this.quoteTransferRemoteGas(
        params.destination,
        undefined,
        params.customHook,
      );
    }

    const { remote_routers } = await this.provider.query.getRemoteRouters({
      token: this.tokenId,
    });

    const router = remote_routers.find(
      (router) => parseInt(router.receiver_domain) === params.destination,
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

    return this.provider.populate.remoteTransfer({
      from_address: params.fromAccountOwner!,
      recipient: addressToBytes32(
        convertToProtocolAddress(params.recipient, ProtocolType.Ethereum),
        ProtocolType.Ethereum,
      ),
      amount: params.weiAmountOrId.toString(),
      token: this.tokenId,
      destination_domain: params.destination,
      gas_limit: router.gas,
      custom_hook_id: '',
      custom_hook_metadata: '',
      max_fee: {
        denom: params.interchainGas.addressOrDenom || '',
        amount: params.interchainGas.amount.toString(),
      },
    });
  }
}

export class RadixHypSyntheticAdapter extends RadixHypCollateralAdapter {}
