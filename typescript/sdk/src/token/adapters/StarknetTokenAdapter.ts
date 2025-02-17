import { BigNumber } from 'ethers';
import { CairoOption, CairoOptionVariant, Call, Contract } from 'starknet';

import { Address, Domain, Numberish } from '@hyperlane-xyz/utils';

import { BaseStarknetAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

export class StarknetHypSyntheticAdapter
  extends BaseStarknetAdapter
  implements IHypTokenAdapter<Call>
{
  public readonly contract: Contract;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { warpRouter: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.contract = this.getHypERC20Contract(this.addresses.warpRouter);
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.contract.balanceOf(address);
  }

  async getMetadata(_isNft?: boolean): Promise<TokenMetadata> {
    const [decimals, symbol, name, totalSupply] = await Promise.all([
      this.contract.decimals(),
      this.contract.symbol(),
      this.contract.name(),
      this.contract.totalSupply() ?? '0',
    ]);
    return { decimals, symbol, name, totalSupply };
  }

  async isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    // Native tokens are ERC20s thus need to be approved
    const allowance = await this.contract.allowance(owner, spender);

    return BigNumber.from(allowance.toString()).lt(
      BigNumber.from(weiAmountOrId),
    );
  }

  async populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<Call> {
    // Native tokens are ERC20s thus need to be approved
    return this.contract.populateTransaction.approve(recipient, weiAmountOrId);
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<Call> {
    return this.contract.populateTransaction.transfer(recipient, weiAmountOrId);
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    return undefined;
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
  ): Promise<InterchainGasQuote> {
    return { amount: BigInt(0) };
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<Call> {
    const nonOption = new CairoOption(CairoOptionVariant.None);

    const transferTx = this.contract.populateTransaction.transfer_remote(
      destination,
      recipient,
      BigInt(weiAmountOrId.toString()),
      BigInt(0),
      nonOption,
      nonOption,
    );

    // TODO: add gas payment when we support it
    return {
      ...transferTx,
      value: interchainGas?.amount
        ? BigNumber.from(interchainGas.amount)
        : BigNumber.from(0),
    };
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async getDomains(): Promise<Domain[]> {
    return [];
  }

  async getRouterAddress(_domain: Domain): Promise<Buffer> {
    return Buffer.from(this.addresses.warpRouter);
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    return [];
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    return undefined;
  }
}
