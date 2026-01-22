import {
  ALEO_NATIVE_DENOM,
  AleoProvider,
  AleoTransaction,
} from '@hyperlane-xyz/aleo-sdk';
import {
  Address,
  Domain,
  Numberish,
  addressToBytes32,
  assert,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseAleoAdapter } from '../../app/MultiProtocolApp.js';
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

export class AleoTokenAdapter
  extends BaseAleoAdapter
  implements ITokenAdapter<AleoTransaction>
{
  protected provider: AleoProvider;
  protected tokenAddress: string;

  protected async getDenom(): Promise<string> {
    return ALEO_NATIVE_DENOM;
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

  async getBalance(address: Address): Promise<bigint> {
    const denom = await this.getDenom();
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
      `name on aleo token ${this.tokenAddress} is undefined`,
    );
    assert(
      symbol !== undefined,
      `symbol on aleo token ${this.tokenAddress} is undefined`,
    );
    assert(
      decimals !== undefined,
      `divisibility on aleo token ${this.tokenAddress} is undefined`,
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

  async isApproveRequired(
    _owner: Address,
    _spender: Address,
    _weiAmountOrId: Numberish,
  ): Promise<boolean> {
    return false;
  }

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
  }

  async populateApproveTx(_params: TransferParams): Promise<AleoTransaction> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx(
    transferParams: TransferParams,
  ): Promise<AleoTransaction> {
    const denom = await this.getDenom();

    assert(transferParams.fromAccountOwner, `no sender in transfer params`);

    return this.provider.getTransferTransaction({
      signer: transferParams.fromAccountOwner,
      recipient: transferParams.recipient,
      denom,
      amount: transferParams.weiAmountOrId.toString(),
    });
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const denom = await this.getDenom();
    return this.provider.getTotalSupply({
      denom,
    });
  }
}

export class AleoNativeTokenAdapter
  extends AleoTokenAdapter
  implements ITokenAdapter<AleoTransaction>
{
  override async getMetadata(): Promise<TokenMetadata> {
    const { nativeToken } = this.multiProvider.getChainMetadata(this.chainName);
    assert(
      nativeToken,
      `Native token data is required for ${AleoNativeTokenAdapter.name}`,
    );

    return {
      name: nativeToken.name,
      symbol: nativeToken.symbol,
      decimals: nativeToken.decimals,
    };
  }
}

export class BaseAleoHypTokenAdapter
  extends AleoTokenAdapter
  implements IHypTokenAdapter<AleoTransaction>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  protected async getDenom(): Promise<string> {
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
    customHook,
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    const { denom: addressOrDenom, amount } =
      await this.provider.quoteRemoteTransfer({
        tokenAddress: this.tokenAddress,
        destinationDomainId: destination,
        customHookAddress: customHook,
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
  ): Promise<AleoTransaction> {
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
        `Require denom for max fee, didn't receive a denom in the interchainGas quote`,
      );
    }

    return this.provider.getRemoteTransferTransaction({
      signer: params.fromAccountOwner,
      tokenAddress: this.tokenAddress,
      destinationDomainId: params.destination,
      recipient: strip0x(addressToBytes32(params.recipient)),
      amount: params.weiAmountOrId.toString(),
      customHookAddress: params.customHook,
      gasLimit: router.gas,
      maxFee: {
        denom: params.interchainGas.igpQuote?.addressOrDenom,
        amount: params.interchainGas.igpQuote?.amount.toString(),
      },
    });
  }
}

export class AleoHypCollateralAdapter extends BaseAleoHypTokenAdapter {}
export class AleoHypSyntheticAdapter extends BaseAleoHypTokenAdapter {}

export class AleoHypNativeAdapter
  extends BaseAleoHypTokenAdapter
  implements ITokenAdapter<AleoTransaction>
{
  override async getDenom(): Promise<string> {
    return ALEO_NATIVE_DENOM;
  }

  override async getMetadata(): Promise<TokenMetadata> {
    const { nativeToken } = this.multiProvider.getChainMetadata(this.chainName);
    assert(
      nativeToken,
      `Native token data is required for ${AleoHypNativeAdapter.name}`,
    );

    return {
      name: nativeToken.name,
      symbol: nativeToken.symbol,
      decimals: nativeToken.decimals,
    };
  }
}
