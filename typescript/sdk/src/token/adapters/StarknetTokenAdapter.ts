import { BigNumber } from 'ethers';
import {
  CairoOption,
  CairoOptionVariant,
  Call,
  Contract,
  cairo,
  num,
} from 'starknet';

import {
  Address,
  Domain,
  Numberish,
  ProtocolType,
  addressToBytes32,
  assert,
} from '@hyperlane-xyz/utils';

import { BaseStarknetAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import {
  getStarknetEtherContract,
  getStarknetHypERC20CollateralContract,
  getStarknetHypERC20Contract,
} from '../../utils/starknet.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../nativeTokenMetadata.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

export class StarknetTokenAdapter
  extends BaseStarknetAdapter
  implements ITokenAdapter<Call>
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
    const [decimals, symbol, name] = await Promise.all([
      this.contract.decimals(),
      this.contract.symbol(),
      this.contract.name(),
    ]);
    return { decimals, symbol, name };
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
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

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
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
}

export class StarknetHypSyntheticAdapter
  extends StarknetTokenAdapter
  implements IHypTokenAdapter<Call>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { warpRouter: Address },
  ) {
    super(chainName, multiProvider, addresses);
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

  async getDomains(): Promise<Domain[]> {
    return this.contract.domains();
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const routerAddresses = await this.contract.routers(domain);
    return Buffer.from(routerAddresses);
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const domains = await this.getDomains();
    const routers: Buffer[] = await Promise.all(
      domains.map((d) => this.getRouterAddress(d)),
    );
    return domains.map((d, i) => ({ domain: d, address: routers[i] }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    return undefined;
  }

  async quoteTransferRemoteGas(
    destination: Domain,
  ): Promise<InterchainGasQuote> {
    const gasPayment = await this.contract.quote_gas_payment(destination);
    return { amount: BigInt(gasPayment.toString()) };
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<Call> {
    const nonOption = new CairoOption(CairoOptionVariant.None);
    const quote =
      interchainGas || (await this.quoteTransferRemoteGas(destination));
    return this.contract.populateTransaction.transfer_remote(
      destination,
      cairo.uint256(addressToBytes32(recipient)),
      cairo.uint256(BigInt(weiAmountOrId.toString())),
      cairo.uint256(BigInt(quote.amount)),
      nonOption,
      nonOption,
    );
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
    const tokenAddress =
      nativeAddress ??
      PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[ProtocolType.Starknet]!.denom;
    assert(tokenAddress, `Native address not found for chain ${chainName}`);
    this.nativeContract = getStarknetEtherContract(
      tokenAddress,
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
    const amount = BigInt(weiAmountOrId.toString());
    const gasAmount = BigInt(interchainGas?.amount.toString() ?? '0');
    const totalAmount = amount + gasAmount;
    return this.collateralContract.populateTransaction.transfer_remote(
      destination,
      recipient,
      amount,
      cairo.uint256(totalAmount),
      nonOption,
      nonOption,
    );
  }
}
