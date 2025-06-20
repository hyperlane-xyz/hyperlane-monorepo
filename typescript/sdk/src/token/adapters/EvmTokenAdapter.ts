import {
  BigNumber,
  PopulatedTransaction,
  constants as ethersConstants,
  ethers
} from 'ethers';
import { ArcadiaSDK } from 'arcadia-sdk-wip';
import { RefineResult } from 'arcadia-sdk-wip/types/Refine.js';
import { RpcIntentState } from 'arcadia-sdk-wip/types/index.js';

import {
  ERC20,
  ERC20__factory,
  ERC4626__factory,
  GasRouter__factory,
  HypERC20,
  HypERC20Collateral,
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC4626,
  HypERC4626Collateral,
  HypERC4626Collateral__factory,
  HypERC4626__factory,
  HypXERC20,
  HypXERC20Lockbox,
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20,
  IXERC20VS,
  IXERC20VS__factory,
  IXERC20__factory,
  ValueTransferBridge__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  Numberish,
  ZERO_ADDRESS_HEX_32,
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
  IEvmKhalaniIntentTokenAdapter,
  IHypTokenAdapter,
  IHypVSXERC20Adapter,
  IHypXERC20Adapter,
  IMovableCollateralRouterAdapter,
  ITokenAdapter,
  IXERC20VSAdapter,
  InterchainGasQuote,
  RateLimitMidPoint,
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

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
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
    const [decimals, symbol, name] = await Promise.all([
      isNft ? 0 : this.contract.decimals(),
      this.contract.symbol(),
      this.contract.name(),
    ]);
    return { decimals, symbol, name };
  }

  override async isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    const allowance = await this.contract.allowance(owner, spender);
    return allowance.lt(weiAmountOrId);
  }

  async isRevokeApprovalRequired(
    owner: Address,
    spender: Address,
  ): Promise<boolean> {
    const allowance = await this.contract.allowance(owner, spender);

    return !allowance.isZero();
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

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
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
  implements
    IHypTokenAdapter<PopulatedTransaction>,
    IMovableCollateralRouterAdapter<PopulatedTransaction>
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

  override async isRevokeApprovalRequired(
    owner: Address,
    spender: Address,
  ): Promise<boolean> {
    const collateral = await this.getWrappedTokenAdapter();

    return collateral.isRevokeApprovalRequired(owner, spender);
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

  async isRebalancer(account: Address): Promise<boolean> {
    const rebalancers = await this.collateralContract.allowedRebalancers();

    return rebalancers.includes(account);
  }

  async getAllowedDestination(domain: Domain): Promise<Address> {
    const allowedDestinationBytes32 =
      await this.collateralContract.allowedRecipient(domain);

    // If allowedRecipient is not set (returns bytes32(0)),
    // fall back to the enrolled remote router for that domain,
    // matching the contract's fallback logic in MovableCollateralRouter.sol
    if (allowedDestinationBytes32 === ZERO_ADDRESS_HEX_32) {
      const routerBytes32 = await this.collateralContract.routers(domain);
      return bytes32ToAddress(routerBytes32);
    }

    return bytes32ToAddress(allowedDestinationBytes32);
  }

  async isBridgeAllowed(domain: Domain, bridge: Address): Promise<boolean> {
    const allowedBridges = await this.collateralContract.allowedBridges(domain);

    return allowedBridges.includes(bridge);
  }

  async getRebalanceQuotes(
    bridge: Address,
    domain: Domain,
    recipient: Address,
    amount: Numberish,
    isWarp: boolean,
  ): Promise<InterchainGasQuote[]> {
    // TODO: In the future, all bridges should get quotes from the quoteTransferRemote function.
    // Given that currently warp routes used as bridges do not, quotes need to be obtained differently.
    // This can probably be removed in the future.
    if (isWarp) {
      const gasRouter = GasRouter__factory.connect(bridge, this.getProvider());
      const gasPayment = await gasRouter.quoteGasPayment(domain);

      return [
        {
          amount: BigInt(gasPayment.toString()),
        },
      ];
    }

    const bridgeContract = ValueTransferBridge__factory.connect(
      bridge,
      this.getProvider(),
    );

    const quotes = await bridgeContract.quoteTransferRemote(
      domain,
      addressToBytes32(recipient),
      amount,
    );

    return quotes.map((quote) => ({
      addressOrDenom:
        quote.token === ethersConstants.AddressZero ? undefined : quote.token,
      amount: BigInt(quote.amount.toString()),
    }));
  }

  /**
   * @param quotes - The quotes returned by getRebalanceQuotes
   */
  populateRebalanceTx(
    domain: Domain,
    amount: Numberish,
    bridge: Address,
    quotes: InterchainGasQuote[],
  ): Promise<PopulatedTransaction> {
    // Obtains the trx value by adding the amount of all quotes with no addressOrDenom (native tokens)
    const value = quotes.reduce(
      (value, quote) => (!quote.addressOrDenom ? value + quote.amount : value),
      0n,
    );

    return this.collateralContract.populateTransaction.rebalance(
      domain,
      amount,
      bridge,
      {
        value,
      },
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

export class EvmHypRebaseCollateralAdapter
  extends EvmHypCollateralAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  public override collateralContract: HypERC4626Collateral;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.collateralContract = HypERC4626Collateral__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  override async getBridgedSupply(): Promise<bigint> {
    const vault = ERC4626__factory.connect(
      await this.collateralContract.vault(),
      this.getProvider(),
    );
    const balance = await vault.balanceOf(this.addresses.token);
    return balance.toBigInt();
  }
}

export class EvmHypSyntheticRebaseAdapter
  extends EvmHypSyntheticAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  declare public contract: HypERC4626;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses, HypERC4626__factory);
  }

  override async getBridgedSupply(): Promise<bigint> {
    const totalShares = await this.contract.totalShares();
    return totalShares.toBigInt();
  }
}

abstract class BaseEvmHypXERC20Adapter<X extends IXERC20 | IXERC20VS>
  extends EvmHypCollateralAdapter
  implements IHypXERC20Adapter<PopulatedTransaction>
{
  public readonly hypXERC20: HypXERC20;

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

  protected abstract connectXERC20(xerc20Addr: Address): X;

  async getXERC20(): Promise<X> {
    const xerc20Addr = await this.hypXERC20.wrappedToken();
    return this.connectXERC20(xerc20Addr);
  }

  override async getBridgedSupply(): Promise<bigint> {
    const xerc20 = await this.getXERC20();
    // Both IXERC20 and IXERC20VS have totalSupply, name, etc. if they extend ERC20
    const totalSupply = await xerc20.totalSupply();
    return totalSupply.toBigInt();
  }

  async getMintLimit(): Promise<bigint> {
    const xerc20 = await this.getXERC20();
    const limit = await xerc20.mintingCurrentLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getMintMaxLimit(): Promise<bigint> {
    const xerc20 = await this.getXERC20();
    const limit = await xerc20.mintingMaxLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getBurnLimit(): Promise<bigint> {
    const xerc20 = await this.getXERC20();
    const limit = await xerc20.burningCurrentLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getBurnMaxLimit(): Promise<bigint> {
    const xerc20 = await this.getXERC20();
    const limit = await xerc20.burningMaxLimitOf(this.contract.address);
    return limit.toBigInt();
  }
}

abstract class BaseEvmHypXERC20LockboxAdapter<X extends IXERC20 | IXERC20VS>
  extends EvmHypCollateralAdapter
  implements IHypXERC20Adapter<PopulatedTransaction>
{
  protected readonly hypXERC20Lockbox: HypXERC20Lockbox;

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

  async getXERC20(): Promise<X> {
    const xERC20Addr = await this.hypXERC20Lockbox.xERC20();
    return this.connectXERC20(xERC20Addr);
  }

  protected abstract connectXERC20(xERC20Addr: Address): X;

  async getMintLimit(): Promise<bigint> {
    const xERC20 = await this.getXERC20();
    const limit = await xERC20.mintingCurrentLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getMintMaxLimit(): Promise<bigint> {
    const xERC20 = await this.getXERC20();
    const limit = await xERC20.mintingMaxLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getBurnLimit(): Promise<bigint> {
    const xERC20 = await this.getXERC20();
    const limit = await xERC20.burningCurrentLimitOf(this.contract.address);
    return limit.toBigInt();
  }

  async getBurnMaxLimit(): Promise<bigint> {
    const xERC20 = await this.getXERC20();
    const limit = await xERC20.burningMaxLimitOf(this.contract.address);
    return limit.toBigInt();
  }
}

// Interacts with HypXERC20Lockbox contracts
export class EvmHypXERC20LockboxAdapter extends BaseEvmHypXERC20LockboxAdapter<IXERC20> {
  protected connectXERC20(xERC20Addr: Address): IXERC20 {
    return IXERC20__factory.connect(xERC20Addr, this.getProvider());
  }
}

export class EvmHypVSXERC20LockboxAdapter
  extends BaseEvmHypXERC20LockboxAdapter<IXERC20VS>
  implements IHypVSXERC20Adapter<PopulatedTransaction>
{
  protected connectXERC20(xERC20Addr: Address): IXERC20VS {
    return IXERC20VS__factory.connect(xERC20Addr, this.getProvider());
  }

  // If you need to expose rate-limiting calls or other VS-specific logic:
  async getRateLimits(): Promise<RateLimitMidPoint> {
    const xERC20 = await this.getXERC20();
    const rateLimits = await xERC20.rateLimits(this.contract.address);

    return {
      rateLimitPerSecond: BigInt(rateLimits.rateLimitPerSecond.toString()),
      bufferCap: BigInt(rateLimits.bufferCap.toString()),
      lastBufferUsedTime: Number(rateLimits.lastBufferUsedTime),
      bufferStored: BigInt(rateLimits.bufferStored.toString()),
      midPoint: BigInt(rateLimits.midPoint.toString()),
    };
  }
  async populateSetBufferCapTx(
    newBufferCap: bigint,
  ): Promise<PopulatedTransaction> {
    const xERC20 = await this.getXERC20();
    return xERC20.populateTransaction.setBufferCap(
      this.addresses.token,
      newBufferCap,
    );
  }

  async populateSetRateLimitPerSecondTx(
    newRateLimitPerSecond: bigint,
  ): Promise<PopulatedTransaction> {
    const xERC20 = await this.getXERC20();
    return xERC20.populateTransaction.setRateLimitPerSecond(
      this.addresses.token,
      newRateLimitPerSecond,
    );
  }

  async populateAddBridgeTx(
    bufferCap: bigint,
    rateLimitPerSecond: bigint,
  ): Promise<PopulatedTransaction> {
    const xERC20 = await this.getXERC20();
    return xERC20.populateTransaction.addBridge({
      bufferCap,
      rateLimitPerSecond,
      bridge: this.addresses.token,
    });
  }
}

// Interacts with HypXERC20 contracts
export class EvmHypXERC20Adapter extends BaseEvmHypXERC20Adapter<IXERC20> {
  protected connectXERC20(xerc20Addr: string): IXERC20 {
    return IXERC20__factory.connect(xerc20Addr, this.getProvider());
  }
}

export class EvmHypVSXERC20Adapter
  extends BaseEvmHypXERC20Adapter<IXERC20VS>
  implements IHypVSXERC20Adapter<PopulatedTransaction>
{
  protected connectXERC20(xerc20Addr: string): IXERC20VS {
    return IXERC20VS__factory.connect(xerc20Addr, this.getProvider());
  }

  async getRateLimits(): Promise<RateLimitMidPoint> {
    const xERC20 = await this.getXERC20();
    const rateLimits = await xERC20.rateLimits(this.contract.address);

    return {
      rateLimitPerSecond: BigInt(rateLimits.rateLimitPerSecond.toString()),
      bufferCap: BigInt(rateLimits.bufferCap.toString()),
      lastBufferUsedTime: Number(rateLimits.lastBufferUsedTime),
      bufferStored: BigInt(rateLimits.bufferStored.toString()),
      midPoint: BigInt(rateLimits.midPoint.toString()),
    };
  }

  async populateSetBufferCapTx(
    newBufferCap: bigint,
  ): Promise<PopulatedTransaction> {
    const xERC20 = await this.getXERC20();
    return xERC20.populateTransaction.setBufferCap(
      this.addresses.token,
      newBufferCap,
    );
  }

  async populateSetRateLimitPerSecondTx(
    newRateLimitPerSecond: bigint,
  ): Promise<PopulatedTransaction> {
    const xERC20 = await this.getXERC20();
    return xERC20.populateTransaction.setRateLimitPerSecond(
      this.addresses.token,
      newRateLimitPerSecond,
    );
  }

  async populateAddBridgeTx(
    bufferCap: bigint,
    rateLimitPerSecond: bigint,
  ): Promise<PopulatedTransaction> {
    const xERC20 = await this.getXERC20();
    return xERC20.populateTransaction.addBridge({
      bufferCap,
      rateLimitPerSecond,
      bridge: this.addresses.token,
    });
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

  override async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
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

  /**
   * @param quotes - The quotes returned by getRebalanceQuotes
   */
  override populateRebalanceTx(
    domain: Domain,
    amount: Numberish,
    bridge: Address,
    quotes: InterchainGasQuote[],
  ): Promise<PopulatedTransaction> {
    // Obtains the trx value by adding the amount of all quotes with no addressOrDenom (native tokens)
    const value = quotes.reduce(
      (value, quote) => (!quote.addressOrDenom ? value + quote.amount : value),
      // Uses the amount to transfer as base value given that the amount is defined in native tokens for this adapter
      BigInt(amount),
    );

    return this.collateralContract.populateTransaction.rebalance(
      domain,
      amount,
      bridge,
      {
        value,
      },
    );
  }
}

export class EvmXERC20VSAdapter
  extends EvmTokenAdapter
  implements IXERC20VSAdapter<PopulatedTransaction>
{
  xERC20VS: IXERC20VS;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.xERC20VS = IXERC20VS__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  async getRateLimits(bridge: Address): Promise<RateLimitMidPoint> {
    const result = await this.xERC20VS.rateLimits(bridge);

    const rateLimits: RateLimitMidPoint = {
      rateLimitPerSecond: BigInt(result.rateLimitPerSecond.toString()),
      bufferCap: BigInt(result.bufferCap.toString()),
      lastBufferUsedTime: Number(result.lastBufferUsedTime),
      bufferStored: BigInt(result.bufferStored.toString()),
      midPoint: BigInt(result.midPoint.toString()),
    };

    return rateLimits;
  }

  // remove bridge
  async populateRemoveBridgeTx(bridge: Address): Promise<PopulatedTransaction> {
    return this.xERC20VS.populateTransaction.removeBridge(bridge);
  }

  async populateSetBufferCapTx(
    bridge: Address,
    newBufferCap: bigint,
  ): Promise<PopulatedTransaction> {
    return this.xERC20VS.populateTransaction.setBufferCap(
      bridge,
      newBufferCap.toString(),
    );
  }

  async populateSetRateLimitPerSecondTx(
    bridge: Address,
    newRateLimitPerSecond: bigint,
  ): Promise<PopulatedTransaction> {
    return this.xERC20VS.populateTransaction.setRateLimitPerSecond(
      bridge,
      newRateLimitPerSecond.toString(),
    );
  }

  async populateAddBridgeTx(
    bufferCap: bigint,
    rateLimitPerSecond: bigint,
    bridge: Address,
  ): Promise<PopulatedTransaction> {
    return this.xERC20VS.populateTransaction.addBridge({
      bufferCap: bufferCap.toString(),
      rateLimitPerSecond: rateLimitPerSecond.toString(),
      bridge,
    });
  }
}

export class EvmKhalaniIntentTokenAdapter
  extends EvmTokenAdapter
  implements IEvmKhalaniIntentTokenAdapter<PopulatedTransaction>
{
  private arcadiaProvider: ethers.providers.JsonRpcProvider;
  private mTokenContract;
  private assetReservesContract;
  private intentBookContract;
  private intentService;
  private refineService;
  private depositService;
  private chainId;
  private tokensService;
  private readonly arcadiaChainId = 1098411886;
  private readonly intentBookAddress;

  static getArcadiaSdk() {
    return new ArcadiaSDK('EthersV5');
  }

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      token: Address;
      addressOrDenom: Address;
    },
  ) {
    super(chainName, multiProvider, addresses);

    const chainProvider = this.multiProvider.getEthersV5Provider(chainName);
    const arcadiaSdk = EvmKhalaniIntentTokenAdapter.getArcadiaSdk();
    const walletService = arcadiaSdk.walletService;
    const contractService = arcadiaSdk.contractService;
    const arcadiaChainInfo = walletService.getArcadiaChainInfo();

    this.chainId = Number(this.multiProvider.getChainId(chainName));
    this.tokensService = arcadiaSdk.tokensService;
    this.intentService = arcadiaSdk.intentService;
    this.refineService = arcadiaSdk.refineService;
    this.depositService = arcadiaSdk.depositService;
    this.intentBookAddress = contractService.getIntentBookAddress();
    // instantiate arcadia provider (Khalani's chain)
    this.arcadiaProvider = new ethers.providers.JsonRpcProvider(
      arcadiaChainInfo.rpcUrl[0],
    );

    // instantiate assetReserves
    this.assetReservesContract = new ethers.Contract(
      this.addresses.addressOrDenom,
      contractService.getAssetReservesABI(),
      chainProvider,
    ) as ethers.Contract & {
      deposit: (
        token: string,
        amount: ethers.BigNumber,
        destChain: number,
      ) => Promise<ethers.ContractTransaction>;
    };

    // instantiate intentBook
    this.intentBookContract = new ethers.Contract(
      this.intentBookAddress,
      contractService.getIntentBookABI(),
      this.arcadiaProvider,
    ) as ethers.Contract & {
      getNonce: (address: string) => Promise<ethers.BigNumber>;
    };

    // Instantiate the mToken contract
    // This token lives in Arcadia chain and tracks the user balances of the mirror tokens.
    this.mTokenContract = new ethers.Contract(
      contractService.getMTokenAddress(this.chainId, this.contract.address),
      contractService.getMTokenABI(),
      this.arcadiaProvider,
    ) as ethers.Contract & {
      balanceOf: (account: string) => Promise<ethers.BigNumber>;
    };
  }

  private async getMTokenBalance(account: string): Promise<bigint> {
    const balance = await this.mTokenContract.balanceOf(account);
    return BigInt(balance.toString());
  }

  async getBalance(address: Address): Promise<bigint> {
    const balance = await this.contract.balanceOf(address);
    return BigInt(balance.toString());
  }

  async isApproveRequired(
    owner: Address,
    _spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    const allowance = await this.contract.allowance(
      owner,
      this.addresses.addressOrDenom,
    );
    return allowance.lt(weiAmountOrId);
  }

  async populateApproveTx({
    weiAmountOrId,
  }: TransferParams): Promise<PopulatedTransaction> {
    return this.contract.populateTransaction.approve(
      this.addresses.addressOrDenom,
      weiAmountOrId.toString(),
    );
  }

  async populateTransferTx({
    weiAmountOrId,
  }: TransferParams): Promise<PopulatedTransaction> {
    const data = await this.assetReservesContract.populateTransaction.deposit(
      this.contract.address,
      BigNumber.from(weiAmountOrId),
      this.arcadiaChainId,
      {
        value: this.depositService.getGasValue(),
      },
    );

    return data;
  }

  async createRefine(
    sender: string,
    toChainId: number,
    amount: string,
  ): Promise<string> {
    const currentNonce = await this.intentBookContract.getNonce(sender);

    const refine = await this.refineService.createRefine({
      accountAddress: sender,
      fromChainId: this.chainId,
      fromTokenAddress: this.addresses.token,
      amount: BigInt(amount),
      toChainId,
      toTokenAddress: this.tokensService.getTokenInDestinyChain({
        fromChainId: this.chainId,
        toChainId,
        tokenAddress: this.addresses.token,
      }).address,
      currentNonce: BigInt(currentNonce.add(1).toString()),
    });

    return refine;
  }

  async queryRefine(refineId: string): Promise<RefineResult> {
    const result = await this.refineService.queryRefine(refineId);
    if (result == 'RefinementNotFound') {
      throw new Error('Refine not found');
    }
    return result as RefineResult;
  }

  async waitForMTokenMinting(
    expectedBalance: bigint,
    account: string,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < 60_000) {
      const currentBalance = await this.getMTokenBalance(account);
      if (currentBalance >= expectedBalance) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    throw new Error('Timeout: waiting for mToken mining.');
  }

  async buildIntentSigningPayload(
    refineResult: RefineResult,
    account: string,
  ): Promise<any> {
    return this.intentService.buildSignIntentPayload({
      refineResult,
      account,
    });
  }

  async proposeIntent(
    refineResult: RefineResult,
    signature: string,
  ): Promise<{
    transactionHash: string;
    intentId: string;
  }> {
    return this.intentService.proposeIntent({
      refineResult,
      signature,
    });
  }

  async getIntentStatus(intentId: string): Promise<RpcIntentState> {
    return this.intentService.getIntentStatus(intentId);
  }
}

export class EvmKhalaniHypAdapter
  extends EvmKhalaniIntentTokenAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      token: Address;
      addressOrDenom: Address;
    },
  ) {
    super(chainName, multiProvider, addresses);
  }
  set deadline(value: number) {
    throw new Error('Method not implemented.');
  }
  getDomains(): Promise<Domain[]> {
    throw new Error('Method not implemented.');
  }
  getRouterAddress(_domain: Domain): Promise<Buffer> {
    throw new Error('Method not implemented.');
  }
  getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    throw new Error('Method not implemented.');
  }
  getBridgedSupply(): Promise<bigint | undefined> {
    throw new Error('Method not implemented.');
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
    _sender?: Address,
    amount?: string,
  ): Promise<InterchainGasQuote> {
    if (!amount || !_sender) {
      return { amount: 0n, addressOrDenom: this.addresses.addressOrDenom };
    }

    const refineId = await this.createRefine(_sender, _destination, amount);
    const refine = await this.queryRefine(refineId);
    return {
      amount: BigInt(amount) - BigInt(refine.Refinement.outcome.mAmounts[0]),
      addressOrDenom: this.addresses.addressOrDenom,
    };
  }

  populateTransferRemoteTx(
    _p: TransferRemoteParams,
  ): Promise<PopulatedTransaction> {
    return this.populateTransferTx(_p);
  }
}
