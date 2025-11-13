import { AleoProvider, AleoTransaction } from '@hyperlane-xyz/aleo-sdk';
import { Address, Numberish, assert } from '@hyperlane-xyz/utils';

import { BaseAleoAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import { ITokenAdapter, TransferParams } from './ITokenAdapter.js';

export class AleoTokenAdapter
  extends BaseAleoAdapter
  implements ITokenAdapter<AleoTransaction>
{
  protected provider: AleoProvider;
  protected tokenAddress: string;

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
    return this.provider.getBalance({
      address,
    });
  }

  async getMetadata(): Promise<TokenMetadata> {
    const nativeToken = await this.provider.getToken({
      tokenAddress: this.tokenAddress,
    });

    return {
      name: nativeToken.name,
      symbol: nativeToken.symbol,
      decimals: nativeToken.decimals,
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
    assert(transferParams.fromAccountOwner, `no sender in transfer params`);

    return this.provider.getTransferTransaction({
      signer: transferParams.fromAccountOwner,
      recipient: transferParams.recipient,
      denom: '',
      amount: transferParams.weiAmountOrId.toString(),
    });
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // Not implemented, native tokens don't have an accessible total supply
    return undefined;
  }
}
