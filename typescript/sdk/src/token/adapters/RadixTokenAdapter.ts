import { BigNumber } from 'bignumber.js';

import { RadixSDK } from '@hyperlane-xyz/radix-sdk';
import {
  Address,
  Domain,
  addressToBytes32,
  assert,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseRadixAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { RadixSDKTransaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

export class RadixNativeTokenAdapter
  extends BaseRadixAdapter
  implements ITokenAdapter<RadixSDKTransaction>
{
  protected provider: RadixSDK;
  protected tokenId: string;

  protected async getResourceAddress(): Promise<string> {
    return this.tokenId;
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
    const resource = await this.getResourceAddress();
    return this.provider.base.getBalance({
      address,
      resource,
    });
  }

  async getMetadata(): Promise<TokenMetadata> {
    const {
      name,
      symbol,
      divisibility: decimals,
    } = await this.provider.query.warp.getToken({
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
    assert(
      decimals !== undefined,
      `divisibility on radix token ${this.tokenId} is undefined`,
    );

    return {
      name,
      symbol,
      decimals,
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
  ): Promise<RadixSDKTransaction> {
    throw new Error('Approve not required for native tokens');
  }

  async isRevokeApprovalRequired(_: Address, __: Address): Promise<boolean> {
    return false;
  }

  async populateTransferTx(
    transferParams: TransferParams,
  ): Promise<RadixSDKTransaction> {
    const resource = await this.getResourceAddress();

    assert(transferParams.fromAccountOwner, `no sender in transfer params`);

    return {
      networkId: this.provider.getNetworkId(),
      manifest: await this.provider.base.transfer({
        from_address: transferParams.fromAccountOwner!,
        to_address: transferParams.recipient,
        resource_address: resource,
        amount: transferParams.weiAmountOrId.toString(),
      }),
    };
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const resource = await this.getResourceAddress();
    return this.provider.base.getTotalSupply({
      resource,
    });
  }
}

export class RadixHypCollateralAdapter
  extends RadixNativeTokenAdapter
  implements IHypTokenAdapter<RadixSDKTransaction>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  protected async getResourceAddress(): Promise<string> {
    const { origin_denom } = await this.provider.query.warp.getToken({
      token: this.tokenId,
    });
    return origin_denom;
  }

  async getDomains(): Promise<Domain[]> {
    const { remote_routers } = await this.provider.query.warp.getRemoteRouters({
      token: this.tokenId,
    });

    return remote_routers.map((router) => parseInt(router.receiver_domain));
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const { remote_routers } = await this.provider.query.warp.getRemoteRouters({
      token: this.tokenId,
    });

    const router = remote_routers.find(
      (router) => parseInt(router.receiver_domain) === domain,
    );

    if (!router) {
      throw new Error(`Router with domain "${domain}" not found`);
    }

    return Buffer.from(strip0x(router.receiver_contract), 'hex');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const { remote_routers } = await this.provider.query.warp.getRemoteRouters({
      token: this.tokenId,
    });

    return remote_routers.map((router) => ({
      domain: parseInt(router.receiver_domain),
      address: Buffer.from(strip0x(router.receiver_contract), 'hex'),
    }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    return this.provider.query.warp.getBridgedSupply({ token: this.tokenId });
  }

  async quoteTransferRemoteGas(
    destination: Domain,
  ): Promise<InterchainGasQuote> {
    const { resource: addressOrDenom, amount } =
      await this.provider.query.warp.quoteRemoteTransfer({
        token: this.tokenId,
        destination_domain: destination,
      });

    return {
      addressOrDenom,
      amount,
    };
  }

  async populateTransferRemoteTx(
    params: TransferRemoteParams,
  ): Promise<RadixSDKTransaction> {
    assert(params.fromAccountOwner, `no sender in remote transfer params`);

    if (!params.interchainGas) {
      params.interchainGas = await this.quoteTransferRemoteGas(
        params.destination,
      );
    }

    const { remote_routers } = await this.provider.query.warp.getRemoteRouters({
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

    return {
      networkId: this.provider.getNetworkId(),
      manifest: await this.provider.populate.warp.remoteTransfer({
        from_address: params.fromAccountOwner!,
        recipient: strip0x(addressToBytes32(params.recipient)),
        amount: params.weiAmountOrId.toString(),
        token: this.tokenId,
        destination_domain: params.destination,
        gas_limit: router.gas,
        custom_hook_id: params.customHook || '',
        custom_hook_metadata: '',
        max_fee: {
          denom: params.interchainGas.addressOrDenom || '',
          // convert the attos back to a Decimal with scale 18
          amount: new BigNumber(params.interchainGas.amount.toString())
            .div(new BigNumber(10).pow(18))
            .toString(),
        },
      }),
    };
  }
}

export class RadixHypSyntheticAdapter extends RadixHypCollateralAdapter {}
