import { BigNumber, PopulatedTransaction } from 'ethers';

import {
  ERC20,
  ERC20__factory,
  HypERC20,
  HypERC20Collateral,
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypXERC20,
  HypXERC20Lockbox,
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  Numberish,
  addressToByteHexString,
  addressToBytes32,
  bytes32ToAddress,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  IHypXERC20Adapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

// An estimate of the gas amount for a typical EVM token router transferRemote transaction
// Computed by estimating on a few different chains, taking the max, and then adding ~50% padding
export const EVM_TRANSFER_REMOTE_GAS_ESTIMATE = 450_000n;

// Interacts with native currencies
export class EvmNativeTokenAdapter
  extends BaseEvmAdapter
  implements ITokenAdapter<PopulatedTransaction>
{
  async getBalance(address: Address): Promise<bigint> {
    const balance = await this.getProvider().getBalance(address);
    return BigInt(balance.toString());
  }

  async getMetadata(): Promise<TokenMetadata> {
    // TODO get metadata from chainMetadata config
    throw new Error('Metadata not available to native tokens');
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

  async populateApproveTx(
    _params: TransferParams,
  ): Promise<PopulatedTransaction> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    const value = BigNumber.from(weiAmountOrId.toString());
    return { value, to: recipient };
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // Not implemented, native tokens don't have an accessible total supply
    return undefined;
  }
}

// Interacts with ERC20/721 contracts
export class EvmTokenAdapter<T extends ERC20 = ERC20>
  extends EvmNativeTokenAdapter
  implements ITokenAdapter<PopulatedTransaction>
{
  public readonly contract: T;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly contractFactory: any = ERC20__factory,
  ) {
    super(chainName, multiProvider, addresses);
    this.contract = contractFactory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  override async getBalance(address: Address): Promise<bigint> {
    const balance = await this.contract.balanceOf(address);
    return BigInt(balance.toString());
  }

  override async getMetadata(isNft?: boolean): Promise<TokenMetadata> {
    const [decimals, symbol, name, totalSupply] = await Promise.all([
      isNft ? 0 : this.contract.decimals(),
      this.contract.symbol(),
      this.contract.name(),
      this.getTotalSupply(),
    ]);
    return { decimals, symbol, name, totalSupply: totalSupply.toString() };
  }

  override async isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    const allowance = await this.contract.allowance(owner, spender);
    return allowance.lt(weiAmountOrId);
  }

  override populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    return this.contract.populateTransaction.approve(
      recipient,
      weiAmountOrId.toString(),
    );
  }

  override populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    return this.contract.populateTransaction.transfer(
      recipient,
      weiAmountOrId.toString(),
    );
  }

  async getTotalSupply(): Promise<bigint> {
    const totalSupply = await this.contract.totalSupply();
    return totalSupply.toBigInt();
  }
}

// Interacts with Hyp Synthetic token contracts (aka 'HypTokens')
export class EvmHypSyntheticAdapter
  extends EvmTokenAdapter<HypERC20>
  implements IHypTokenAdapter<PopulatedTransaction>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly contractFactory: any = HypERC20__factory,
  ) {
    super(chainName, multiProvider, addresses, contractFactory);
  }

  override async isApproveRequired(
    _owner: Address,
    _spender: Address,
    _weiAmountOrId: Numberish,
  ): Promise<boolean> {
    return false;
  }

  getDomains(): Promise<Domain[]> {
    return this.contract.domains();
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const routerAddressesAsBytes32 = await this.contract.routers(domain);
    // Evm addresses will be padded with 12 bytes
    if (routerAddressesAsBytes32.startsWith('0x000000000000000000000000')) {
      return Buffer.from(
        strip0x(bytes32ToAddress(routerAddressesAsBytes32)),
        'hex',
      );
      // Otherwise leave the address unchanged
    } else {
      return Buffer.from(strip0x(routerAddressesAsBytes32), 'hex');
    }
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const domains = await this.getDomains();
    const routers: Buffer[] = await Promise.all(
      domains.map((d) => this.getRouterAddress(d)),
    );
    return domains.map((d, i) => ({ domain: d, address: routers[i] }));
  }

  getBridgedSupply(): Promise<bigint | undefined> {
    return this.getTotalSupply();
  }

  async quoteTransferRemoteGas(
    destination: Domain,
  ): Promise<InterchainGasQuote> {
    const gasPayment = await this.contract.quoteGasPayment(destination);
    // If EVM hyp contracts eventually support alternative IGP tokens,
    // this would need to determine the correct token address
    return { amount: BigInt(gasPayment.toString()) };
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<PopulatedTransaction> {
    if (!interchainGas)
      interchainGas = await this.quoteTransferRemoteGas(destination);

    const recipBytes32 = addressToBytes32(addressToByteHexString(recipient));
    return this.contract.populateTransaction[
      'transferRemote(uint32,bytes32,uint256)'
    ](destination, recipBytes32, weiAmountOrId, {
      value: interchainGas.amount.toString(),
    });
  }
}

// Interacts with HypCollateral contracts
export class EvmHypCollateralAdapter
  extends EvmHypSyntheticAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  public readonly collateralContract: HypERC20Collateral;
  protected wrappedTokenAddress?: Address;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.collateralContract = HypERC20Collateral__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  protected async getWrappedTokenAddress(): Promise<Address> {
    if (!this.wrappedTokenAddress) {
      this.wrappedTokenAddress = await this.collateralContract.wrappedToken();
    }
    return this.wrappedTokenAddress!;
  }

  protected async getWrappedTokenAdapter(): Promise<EvmTokenAdapter> {
    return new EvmTokenAdapter(this.chainName, this.multiProvider, {
      token: await this.getWrappedTokenAddress(),
    });
  }

  override getBridgedSupply(): Promise<bigint | undefined> {
    return this.getBalance(this.addresses.token);
  }

  override getMetadata(isNft?: boolean): Promise<TokenMetadata> {
    return this.getWrappedTokenAdapter().then((t) => t.getMetadata(isNft));
  }

  override isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    return this.getWrappedTokenAdapter().then((t) =>
      t.isApproveRequired(owner, spender, weiAmountOrId),
    );
  }

  override populateApproveTx(
    params: TransferParams,
  ): Promise<PopulatedTransaction> {
    return this.getWrappedTokenAdapter().then((t) =>
      t.populateApproveTx(params),
    );
  }

  override populateTransferTx(
    params: TransferParams,
  ): Promise<PopulatedTransaction> {
    return this.getWrappedTokenAdapter().then((t) =>
      t.populateTransferTx(params),
    );
  }
}

export class EvmHypCollateralFiatAdapter
  extends EvmHypCollateralAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  /**
   * Note this may be inaccurate, as this returns the total supply
   * of the fiat token, which may be used by other bridges.
   * However this is the best we can do with a simple view call.
   */
  override async getBridgedSupply(): Promise<bigint> {
    const wrapped = await this.getWrappedTokenAdapter();
    return wrapped.getTotalSupply();
  }
}

// Interacts with HypXERC20Lockbox contracts
export class EvmHypXERC20LockboxAdapter
  extends EvmHypCollateralAdapter
  implements IHypXERC20Adapter<PopulatedTransaction>
{
  hypXERC20Lockbox: HypXERC20Lockbox;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.hypXERC20Lockbox = HypXERC20Lockbox__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  /**
   * Note this may be inaccurate, as this returns the balance
   * of the lockbox contract, which may be used by other bridges.
   * However this is the best we can do with a simple view call.
   */
  override async getBridgedSupply(): Promise<bigint> {
    const lockboxAddress = await this.hypXERC20Lockbox.lockbox();
    return this.getBalance(lockboxAddress);
  }

  async getMintLimit(): Promise<bigint> {
    const xERC20 = await this.getXErc20();
    const limit = await xERC20.mintingCurrentLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getMintMaxLimit(): Promise<bigint> {
    const xERC20 = await this.getXErc20();
    const limit = await xERC20.mintingMaxLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getBurnLimit(): Promise<bigint> {
    const xERC20 = await this.getXErc20();
    const limit = await xERC20.burningCurrentLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getBurnMaxLimit(): Promise<bigint> {
    const xERC20 = await this.getXErc20();
    const limit = await xERC20.burningMaxLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getXErc20(): Promise<IXERC20> {
    const xERC20 = await this.hypXERC20Lockbox.xERC20();

    return IXERC20__factory.connect(xERC20, this.getProvider());
  }
}

// Interacts with HypXERC20 contracts
export class EvmHypXERC20Adapter
  extends EvmHypCollateralAdapter
  implements IHypXERC20Adapter<PopulatedTransaction>
{
  hypXERC20: HypXERC20;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.hypXERC20 = HypXERC20__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  /**
   * Note this may be inaccurate, as this returns the total supply
   * of the xERC20 contract, which may be used by other bridges.
   * However this is the best we can do with a simple view call.
   */
  override async getBridgedSupply(): Promise<bigint> {
    const xerc20TokenAddress = await this.hypXERC20.wrappedToken();
    const xerc20 = new EvmTokenAdapter(this.chainName, this.multiProvider, {
      token: xerc20TokenAddress,
    });
    return xerc20.getTotalSupply();
  }

  async getMintLimit(): Promise<bigint> {
    const xERC20 = await this.getXErc20();
    const limit = await xERC20.mintingCurrentLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getMintMaxLimit(): Promise<bigint> {
    const xERC20 = await this.getXErc20();
    const limit = await xERC20.mintingMaxLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getBurnLimit(): Promise<bigint> {
    const xERC20 = await this.getXErc20();
    const limit = await xERC20.burningCurrentLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getBurnMaxLimit(): Promise<bigint> {
    const xERC20 = await this.getXErc20();
    const limit = await xERC20.burningMaxLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getXErc20(): Promise<IXERC20> {
    const xERC20 = await this.hypXERC20.wrappedToken();

    return IXERC20__factory.connect(xERC20, this.getProvider());
  }
}

// Interacts HypNative contracts
export class EvmHypNativeAdapter
  extends EvmHypCollateralAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  override async isApproveRequired(): Promise<boolean> {
    return false;
  }

  override async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<PopulatedTransaction> {
    if (!interchainGas)
      interchainGas = await this.quoteTransferRemoteGas(destination);

    let txValue: bigint | undefined = undefined;
    const { addressOrDenom: igpAddressOrDenom, amount: igpAmount } =
      interchainGas;
    // If the igp token is native Eth
    if (!igpAddressOrDenom) {
      txValue = igpAmount + BigInt(weiAmountOrId);
    } else {
      txValue = igpAmount;
    }

    const recipBytes32 = addressToBytes32(addressToByteHexString(recipient));
    return this.contract.populateTransaction[
      'transferRemote(uint32,bytes32,uint256)'
    ](destination, recipBytes32, weiAmountOrId, { value: txValue?.toString() });
  }
}
