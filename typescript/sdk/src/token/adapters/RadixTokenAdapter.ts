import { BigNumber } from 'bignumber.js';

import { RadixProvider, RadixSDKTransaction } from '@hyperlane-xyz/radix-sdk';
import {
  Address,
  Domain,
  addressToBytes32,
  assert,
  fromWei,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseRadixAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
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

export class RadixNativeTokenAdapter
  extends BaseRadixAdapter
  implements ITokenAdapter<RadixSDKTransaction>
{
  protected provider: RadixProvider;
  protected tokenAddress: string;

  protected async getResourceAddress(): Promise<string> {
    return this.tokenAddress;
  }

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.provider = this.getProvider();
    this.tokenAddress = addresses.token;
  }

  async getBalance(address: string): Promise<bigint> {
    const denom = await this.getResourceAddress();
    return this.provider.getBalance({
      address,
      denom,
    });
  }

  async getMetadata(): Promise<TokenMetadata> {
    const { name, symbol, decimals } = await this.provider.getToken({
      tokenAddress: this.tokenAddress,
    });

    assert(
      name !== undefined,
      `name on radix token ${this.tokenAddress} is undefined`,
    );
    assert(
      symbol !== undefined,
      `symbol on radix token ${this.tokenAddress} is undefined`,
    );
    assert(
      decimals !== undefined,
      `divisibility on radix token ${this.tokenAddress} is undefined`,
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
    const denom = await this.getResourceAddress();

    const { nativeToken } = this.multiProvider.getChainMetadata(this.chainName);
    assert(
      nativeToken,
      `Native token data is required for ${RadixNativeTokenAdapter.name}`,
    );
    assert(transferParams.fromAccountOwner, `no sender in transfer params`);

    return this.provider.getTransferTransaction({
      signer: transferParams.fromAccountOwner,
      recipient: transferParams.recipient,
      denom,
      amount: fromWei(
        transferParams.weiAmountOrId.toString(),
        nativeToken.decimals,
      ),
    });
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const denom = await this.getResourceAddress();
    return this.provider.getTotalSupply({
      denom,
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
    const { denom } = await this.provider.getToken({
      tokenAddress: this.tokenAddress,
    });
    return denom;
  }

  async getDomains(): Promise<Domain[]> {
    const { remoteRouters } = await this.provider.getRemoteRouters({
      tokenAddress: this.tokenAddress,
    });

    return remoteRouters.map((router) => router.receiverDomainId);
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const { remoteRouters } = await this.provider.getRemoteRouters({
      tokenAddress: this.tokenAddress,
    });

    const router = remoteRouters.find(
      (router) => router.receiverDomainId === domain,
    );

    if (!router) {
      throw new Error(`Router with domain "${domain}" not found`);
    }

    return Buffer.from(strip0x(router.receiverAddress), 'hex');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const { remoteRouters } = await this.provider.getRemoteRouters({
      tokenAddress: this.tokenAddress,
    });

    return remoteRouters.map((router) => ({
      domain: router.receiverDomainId,
      address: Buffer.from(strip0x(router.receiverAddress), 'hex'),
    }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    return this.provider.getBridgedSupply({
      tokenAddress: this.tokenAddress,
    });
  }

  async quoteTransferRemoteGas({
    destination,
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    const { denom: addressOrDenom, amount } =
      await this.provider.quoteRemoteTransfer({
        tokenAddress: this.tokenAddress,
        destinationDomainId: destination,
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
  ): Promise<RadixSDKTransaction> {
    assert(params.fromAccountOwner, `no sender in remote transfer params`);

    if (!params.interchainGas) {
      params.interchainGas = await this.quoteTransferRemoteGas({
        destination: params.destination,
      });
    }

    const { remoteRouters } = await this.provider.getRemoteRouters({
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

    if (!params.interchainGas.igpQuote?.addressOrDenom) {
      throw new Error(
        `Require denom for max fee, didn't receive and denom in the interchainGas quote`,
      );
    }

    return this.provider.getRemoteTransferTransaction({
      signer: params.fromAccountOwner!,
      tokenAddress: this.tokenAddress,
      destinationDomainId: params.destination,
      recipient: strip0x(addressToBytes32(params.recipient)),
      amount: params.weiAmountOrId.toString(),
      customHookAddress: params.customHook,
      gasLimit: router.gas,
      maxFee: {
        denom: params.interchainGas.igpQuote?.addressOrDenom,
        // convert the attos back to a Decimal with scale 18
        amount: new BigNumber(params.interchainGas.igpQuote?.amount.toString())
          .div(new BigNumber(10).pow(18))
          .toString(),
      },
    });
  }
}

export class RadixHypSyntheticAdapter extends RadixHypCollateralAdapter {}
