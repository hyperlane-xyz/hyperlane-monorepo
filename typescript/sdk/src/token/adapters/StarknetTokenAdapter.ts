import { BigNumber } from 'ethers';
import { CairoOption, CairoOptionVariant, Call, Contract, num } from 'starknet';

import { Address, Domain, Numberish, assert } from '@hyperlane-xyz/utils';

import { BaseStarknetAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import {
  getStarknetHypERC20CollateralContract,
  getStarknetHypERC20Contract,
} from '../../utils/starknet.js';
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
    this.contract = getStarknetHypERC20Contract(
      addresses.warpRouter,
      multiProvider.getStarknetProvider(chainName),
    );
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
    const allowance = await this.contract.allowance(owner, spender);
    return BigNumber.from(allowance.toString()).lt(
      BigNumber.from(weiAmountOrId),
    );
  }

  async populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<Call> {
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
    // console.log('quoteTransferRemoteGas: ', _destination);
    // const quote = await this.contract.quote_gas_payment(_destination);
    // console.log('quote: ', quote);

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

export class StarknetHypCollateralAdapter extends StarknetHypSyntheticAdapter {
  public readonly collateralContract: Contract;
  protected wrappedTokenAddress?: Address;

  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    addresses: { warpRouter: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.collateralContract = getStarknetHypERC20CollateralContract(
      addresses.warpRouter,
      multiProvider.getStarknetProvider(chainName),
    );
  }

  protected async getWrappedTokenAddress(): Promise<Address> {
    if (!this.wrappedTokenAddress) {
      this.wrappedTokenAddress = num.toHex64(
        await this.collateralContract.get_wrapped_token(),
      );
    }
    return this.wrappedTokenAddress!;
  }

  protected async getWrappedTokenAdapter(): Promise<StarknetHypSyntheticAdapter> {
    return new StarknetHypSyntheticAdapter(this.chainName, this.multiProvider, {
      warpRouter: await this.getWrappedTokenAddress(),
    });
  }

  async getBalance(address: Address): Promise<bigint> {
    const adapter = await this.getWrappedTokenAdapter();
    return adapter.getBalance(address);
  }

  override getBridgedSupply(): Promise<bigint | undefined> {
    return this.getBalance(this.addresses.warpRouter);
  }

  override async getMetadata(isNft?: boolean): Promise<TokenMetadata> {
    const adapter = await this.getWrappedTokenAdapter();
    return adapter.getMetadata(isNft);
  }

  override async isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    const adapter = await this.getWrappedTokenAdapter();
    return adapter.isApproveRequired(owner, spender, weiAmountOrId);
  }

  override async populateApproveTx(params: TransferParams): Promise<Call> {
    const adapter = await this.getWrappedTokenAdapter();
    return adapter.populateApproveTx(params);
  }

  override async populateTransferTx(params: TransferParams): Promise<Call> {
    const adapter = await this.getWrappedTokenAdapter();
    return adapter.populateTransferTx(params);
  }
}

export class StarknetHypNativeAdapter extends StarknetHypSyntheticAdapter {
  public readonly collateralContract: Contract;
  public readonly nativeContract: Contract;

  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    addresses: { warpRouter: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.collateralContract = getStarknetHypERC20CollateralContract(
      addresses.warpRouter,
      multiProvider.getStarknetProvider(chainName),
    );
    const nativeAddress =
      multiProvider.getChainMetadata(chainName)?.nativeToken?.denom;
    assert(nativeAddress, `Native address not found for chain ${chainName}`);
    this.nativeContract = getStarknetHypERC20Contract(
      nativeAddress,
      multiProvider.getStarknetProvider(chainName),
    );
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.nativeContract.balanceOf(address);
  }

  async isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    const allowance = await this.nativeContract.allowance(owner, spender);
    return BigNumber.from(allowance.toString()).lt(
      BigNumber.from(weiAmountOrId),
    );
  }

  async populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<Call> {
    return this.nativeContract.populateTransaction.approve(
      recipient,
      weiAmountOrId,
    );
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<Call> {
    const nonOption = new CairoOption(CairoOptionVariant.None);
    const transferTx =
      this.collateralContract.populateTransaction.transfer_remote(
        destination,
        recipient,
        BigInt(weiAmountOrId.toString()),
        BigInt(weiAmountOrId.toString()),
        nonOption,
        nonOption,
      );

    return {
      ...transferTx,
      value: interchainGas?.amount
        ? BigNumber.from(interchainGas.amount)
        : BigNumber.from(0),
    };
  }
}
