import {
  BigNumber,
  PopulatedTransaction,
  constants as ethersConstants,
} from 'ethers';

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
  IFiatToken__factory,
  ITokenBridge__factory,
  IXERC20,
  IXERC20VS,
  IXERC20VS__factory,
  IXERC20__factory,
  MovableCollateralRouter,
  MovableCollateralRouter__factory,
  TokenRouter,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  Numberish,
  ZERO_ADDRESS_HEX_32,
  addressToByteHexString,
  addressToBytes32,
  assert,
  bytes32ToAddress,
  isNullish,
  isZeroishAddress,
  normalizeAddress,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp.js';
import { UIN256_MAX_VALUE } from '../../consts/numbers.js';
import { EthJsonRpcBlockParameterTag } from '../../metadata/chainMetadataTypes.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { isValidContractVersion } from '../../utils/contract.js';
import { TokenMetadata } from '../types.js';

import {
  IHypCollateralFiatAdapter,
  IHypTokenAdapter,
  IHypVSXERC20Adapter,
  IHypXERC20Adapter,
  IMovableCollateralRouterAdapter,
  ITokenAdapter,
  IXERC20Adapter,
  IXERC20VSAdapter,
  InterchainGasQuote,
  Quote,
  QuoteTransferRemoteParams,
  RateLimitMidPoint,
  TransferParams,
  TransferRemoteParams,
  xERC20Limits,
} from './ITokenAdapter.js';
import { buildBlockTagOverrides } from './utils.js';

// An estimate of the gas amount for a typical EVM token router transferRemote transaction
// Computed by estimating on a few different chains, taking the max, and then adding ~50% padding
export const EVM_TRANSFER_REMOTE_GAS_ESTIMATE = 450_000n;
const TOKEN_FEE_CONTRACT_VERSION = '10.0.0';

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
    const { nativeToken } = this.multiProvider.getChainMetadata(this.chainName);
    assert(
      nativeToken,
      `Native token data is required for ${EvmNativeTokenAdapter.name}`,
    );

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

  /**
   * Populates approval transactions that handle USDC-style tokens.
   * USDC doesn't allow changing allowance from non-zero to non-zero,
   * so we must reset to 0 first if there's an existing allowance.
   * Approves MAX_UINT256 so we never need to approve again.
   *
   * @returns Array of transactions: [revokeTx?, approveTx] or [] if already approved for max
   */
  async populateForceApproveTxs({
    owner,
    recipient,
  }: {
    owner: Address;
    recipient: Address;
  }): Promise<PopulatedTransaction[]> {
    const transactions: PopulatedTransaction[] = [];
    const MAX_UINT256 = ethersConstants.MaxUint256;

    // Check if there's an existing allowance
    const currentAllowance = await this.contract.allowance(owner, recipient);

    // If already approved for max, no need for any approval
    if (currentAllowance.eq(MAX_UINT256)) {
      return transactions;
    }

    if (!currentAllowance.isZero()) {
      // Need to reset to 0 first for USDC-style tokens
      const revokeTx = await this.contract.populateTransaction.approve(
        recipient,
        0,
      );
      transactions.push(revokeTx);
    }

    // Approve max so we never need to approve again
    const approveTx = await this.contract.populateTransaction.approve(
      recipient,
      MAX_UINT256,
    );
    transactions.push(approveTx);

    return transactions;
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

  async getBridgedSupply(options?: {
    blockTag?: number | EthJsonRpcBlockParameterTag;
  }): Promise<bigint | undefined> {
    const overrides = buildBlockTagOverrides(options?.blockTag);
    const totalSupply = await this.contract.totalSupply(overrides);
    return totalSupply.toBigInt();
  }

  async getContractPackageVersion() {
    try {
      return await this.contract.PACKAGE_VERSION();
    } catch (err) {
      // PACKAGE_VERSION was introduced in v5.4.0
      this.logger.error(`Error when fetching package version ${err}`);
      return '5.3.9';
    }
  }

  async quoteTransferRemoteGas({
    destination,
    recipient,
    amount,
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    const contractVersion = await this.getContractPackageVersion();
    const hasQuoteTransferRemote = isValidContractVersion(
      contractVersion,
      TOKEN_FEE_CONTRACT_VERSION,
    );
    // Version does not support quoteTransferRemote defaulting to quoteGasPayment
    if (!hasQuoteTransferRemote) {
      const gasPayment = await this.contract.quoteGasPayment(destination);
      return { igpQuote: { amount: BigInt(gasPayment.toString()) } };
    }

    assert(
      !isNullish(amount),
      'Amount must be defined for quoteTransferRemoteGas',
    );
    assert(recipient, 'Recipient must be defined for quoteTransferRemoteGas');

    const recipBytes32 = addressToBytes32(addressToByteHexString(recipient));
    const [igpQuote, ...feeQuotes] = await this.contract.quoteTransferRemote(
      destination,
      recipBytes32,
      amount.toString(),
    );
    const [, igpAmount] = igpQuote;

    const tokenFeeQuotes: Quote[] = feeQuotes.map((quote) => ({
      addressOrDenom: quote[0],
      amount: BigInt(quote[1].toString()),
    }));

    // Because the amount is added on  the fees, we need to subtract it from the actual fees
    const tokenFeeQuote: Quote | undefined =
      tokenFeeQuotes.length > 0
        ? {
            addressOrDenom: tokenFeeQuotes[0].addressOrDenom, // the contract enforces the token address to be the same as the route
            amount:
              tokenFeeQuotes.reduce((sum, q) => sum + q.amount, 0n) - amount,
          }
        : undefined;

    return {
      igpQuote: {
        amount: BigInt(igpAmount.toString()),
      },
      tokenFeeQuote,
    };
  }

  async populateTransferRemoteTx(
    {
      weiAmountOrId,
      destination,
      recipient,
      interchainGas,
    }: TransferRemoteParams,
    nativeValue = 0n,
  ): Promise<PopulatedTransaction> {
    if (!interchainGas)
      interchainGas = await this.quoteTransferRemoteGas({
        destination,
        recipient,
        amount: BigInt(weiAmountOrId),
      });

    // add igp to native value
    nativeValue += interchainGas.igpQuote.amount;

    // add token fee to native value if the denom is undefined or zero address (native token)
    if (
      !interchainGas.tokenFeeQuote?.addressOrDenom ||
      isZeroishAddress(interchainGas.tokenFeeQuote?.addressOrDenom)
    ) {
      nativeValue += interchainGas.tokenFeeQuote?.amount ?? 0n;
    }

    const recipBytes32 = addressToBytes32(addressToByteHexString(recipient));
    return this.contract.populateTransaction[
      'transferRemote(uint32,bytes32,uint256)'
    ](destination, recipBytes32, weiAmountOrId, {
      value: nativeValue.toString(),
    });
  }
}

class BaseEvmHypCollateralAdapter
  extends EvmHypSyntheticAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  public readonly collateralContract: TokenRouter;
  protected wrappedTokenAddress?: Address;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.collateralContract = TokenRouter__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  async getWrappedTokenAddress(): Promise<Address> {
    if (!this.wrappedTokenAddress) {
      this.wrappedTokenAddress = await this.collateralContract.token();
    }
    return this.wrappedTokenAddress!;
  }

  protected async getWrappedTokenAdapter(): Promise<EvmTokenAdapter> {
    return new EvmTokenAdapter(this.chainName, this.multiProvider, {
      token: await this.getWrappedTokenAddress(),
    });
  }

  override async getBalance(address: Address): Promise<bigint> {
    const wrappedTokenAdapter = await this.getWrappedTokenAdapter();
    return wrappedTokenAdapter.getBalance(address);
  }

  override async getBridgedSupply(options?: {
    blockTag?: number | EthJsonRpcBlockParameterTag;
  }): Promise<bigint | undefined> {
    const wrappedTokenAddress = await this.getWrappedTokenAddress();
    const wrappedContract = ERC20__factory.connect(
      wrappedTokenAddress,
      this.getProvider(),
    );
    const overrides = buildBlockTagOverrides(options?.blockTag);
    const balance = await wrappedContract.balanceOf(
      this.addresses.token,
      overrides,
    );
    return BigInt(balance.toString());
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
}

// Interacts with HypCollateral contracts
export class EvmHypCollateralAdapter
  extends BaseEvmHypCollateralAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  public readonly collateralContract: HypERC20Collateral;

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

  override async getWrappedTokenAddress(): Promise<Address> {
    if (!this.wrappedTokenAddress) {
      this.wrappedTokenAddress = await this.collateralContract.wrappedToken();
    }
    return this.wrappedTokenAddress!;
  }
}

export class EvmMovableCollateralAdapter
  extends EvmHypCollateralAdapter
  implements IMovableCollateralRouterAdapter<PopulatedTransaction>
{
  movableCollateral(): MovableCollateralRouter {
    return MovableCollateralRouter__factory.connect(
      this.addresses.token,
      this.getProvider(),
    );
  }

  async isRebalancer(account: Address): Promise<boolean> {
    const rebalancers = await this.movableCollateral().allowedRebalancers();

    return rebalancers.includes(account);
  }

  async getAllowedDestination(domain: Domain): Promise<Address> {
    const allowedDestinationBytes32 =
      await this.movableCollateral().allowedRecipient(domain);

    // If allowedRecipient is not set (returns bytes32(0)),
    // fall back to the enrolled remote router for that domain,
    // matching the contract's fallback logic in MovableCollateralRouter.sol
    if (allowedDestinationBytes32 === ZERO_ADDRESS_HEX_32) {
      const routerBytes32 = await this.movableCollateral().routers(domain);
      return bytes32ToAddress(routerBytes32);
    }

    return bytes32ToAddress(allowedDestinationBytes32);
  }

  async isBridgeAllowed(domain: Domain, bridge: Address): Promise<boolean> {
    const allowedBridges =
      await this.movableCollateral().allowedBridges(domain);

    return allowedBridges
      .map((bridgeAddress) => normalizeAddress(bridgeAddress))
      .includes(normalizeAddress(bridge));
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
          igpQuote: { amount: BigInt(gasPayment.toString()) },
        },
      ];
    }

    const bridgeContract = ITokenBridge__factory.connect(
      bridge,
      this.getProvider(),
    );

    const quotes = await bridgeContract.quoteTransferRemote(
      domain,
      addressToBytes32(recipient),
      amount,
    );

    return quotes.map((quote) => ({
      igpQuote: {
        addressOrDenom:
          quote.token === ethersConstants.AddressZero ? undefined : quote.token,
        amount: BigInt(quote.amount.toString()),
      },
    }));
  }

  /**
   * Populates rebalance transaction(s).
   * Returns an array of transactions: [approvalTx?, rebalanceTx]
   * Approval tx is included only if current allowance for collateral fees is insufficient.
   * @param quotes - The quotes returned by getRebalanceQuotes
   * @param sender - Optional sender address for approval check
   */
  async populateRebalanceTx(
    domain: Domain,
    amount: Numberish,
    bridge: Address,
    quotes: InterchainGasQuote[],
    sender?: Address,
  ): Promise<PopulatedTransaction[]> {
    const transactions: PopulatedTransaction[] = [];

    // 1. Check if collateral token approval is needed (e.g., USDC for CCTP fees)
    if (sender) {
      const collateralFee = this.getCollateralFeeFromQuotes(quotes);
      if (collateralFee && collateralFee.amount > 0n) {
        const tokenAdapter = new EvmTokenAdapter(
          this.chainName,
          this.multiProvider,
          {
            token: collateralFee.token,
          },
        );

        // Check current allowance against MovableCollateralRouter
        const needsApproval = await tokenAdapter.isApproveRequired(
          sender,
          this.addresses.token, // MovableCollateralRouter pulls fees from sender
          collateralFee.amount,
        );

        if (needsApproval) {
          const approvalTxs = await tokenAdapter.populateForceApproveTxs({
            owner: sender,
            recipient: this.addresses.token,
          });
          transactions.push(...approvalTxs);
        }
      }
    }

    // 2. Populate rebalance tx
    // Obtains the trx value by adding the amount of all quotes with no addressOrDenom (native tokens)
    const value = quotes.reduce(
      (v, quote) =>
        !quote.igpQuote.addressOrDenom ? v + quote.igpQuote.amount : v,
      0n,
    );

    const rebalanceTx =
      await this.movableCollateral().populateTransaction.rebalance(
        domain,
        amount,
        bridge,
        { value },
      );
    transactions.push(rebalanceTx);

    return transactions;
  }

  /**
   * Extract collateral token fee from quotes (non-native fees).
   * These are fees paid in ERC20 tokens like USDC for CCTP bridges.
   */
  protected getCollateralFeeFromQuotes(
    quotes: InterchainGasQuote[],
  ): { token: Address; amount: bigint } | undefined {
    // Find quotes with addressOrDenom set (non-native token fees)
    const collateralFees = quotes.filter((q) => q.igpQuote.addressOrDenom);
    if (collateralFees.length === 0) return undefined;

    // Sum all collateral fees (they should all be the same token)
    const totalAmount = collateralFees.reduce(
      (sum, q) => sum + q.igpQuote.amount,
      0n,
    );
    return {
      token: collateralFees[0].igpQuote.addressOrDenom!,
      amount: totalAmount,
    };
  }
}

export class EvmHypCollateralFiatAdapter
  extends EvmHypCollateralAdapter
  implements IHypCollateralFiatAdapter<PopulatedTransaction>
{
  /**
   * Note this may be inaccurate, as this returns the total supply
   * of the fiat token, which may be used by other bridges.
   * However this is the best we can do with a simple view call.
   */
  override async getBridgedSupply(options?: {
    blockTag?: number | EthJsonRpcBlockParameterTag;
  }): Promise<bigint> {
    const wrappedTokenAddress = await this.getWrappedTokenAddress();
    const wrappedContract = ERC20__factory.connect(
      wrappedTokenAddress,
      this.getProvider(),
    );
    const overrides = buildBlockTagOverrides(options?.blockTag);
    const totalSupply = await wrappedContract.totalSupply(overrides);
    return BigInt(totalSupply.toString());
  }

  async getMintLimit(): Promise<bigint> {
    const wrappedToken = await this.getWrappedTokenAddress();
    const fiatToken = IFiatToken__factory.connect(
      wrappedToken,
      this.getProvider(),
    );

    const isMinter = await fiatToken.isMinter(this.addresses.token);
    if (!isMinter) {
      return 0n;
    }

    // if the minterAllowance call fails it probably is because the underlying
    // mintable contract does not define the method and instead does not restrict
    // minting for allowed contracts
    // example: https://etherscan.io/token/0x6468e79A80C0eaB0F9A2B574c8d5bC374Af59414#readContract
    try {
      const limit = await fiatToken.minterAllowance(this.addresses.token);

      return limit.toBigInt();
    } catch {
      return UIN256_MAX_VALUE;
    }
  }
}

export class EvmHypRebaseCollateralAdapter
  extends BaseEvmHypCollateralAdapter
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

  override async getWrappedTokenAddress(): Promise<Address> {
    if (!this.wrappedTokenAddress) {
      this.wrappedTokenAddress = await this.collateralContract.wrappedToken();
    }
    return this.wrappedTokenAddress!;
  }

  override async getBridgedSupply(options?: {
    blockTag?: number | EthJsonRpcBlockParameterTag;
  }): Promise<bigint> {
    const vault = ERC4626__factory.connect(
      await this.collateralContract.vault(),
      this.getProvider(),
    );
    const overrides = buildBlockTagOverrides(options?.blockTag);
    const balance = await vault.balanceOf(this.addresses.token, overrides);
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

  override async getBridgedSupply(options?: {
    blockTag?: number | EthJsonRpcBlockParameterTag;
  }): Promise<bigint> {
    const overrides = buildBlockTagOverrides(options?.blockTag);
    const totalShares = await this.contract.totalShares(overrides);
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

  override async getBridgedSupply(options?: {
    blockTag?: number | EthJsonRpcBlockParameterTag;
  }): Promise<bigint> {
    const xerc20 = await this.getXERC20();
    // Both IXERC20 and IXERC20VS have totalSupply, name, etc. if they extend ERC20
    const overrides = buildBlockTagOverrides(options?.blockTag);
    const totalSupply = await xerc20.totalSupply(overrides);
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
  override async getBridgedSupply(options?: {
    blockTag?: number | EthJsonRpcBlockParameterTag;
  }): Promise<bigint> {
    const lockboxAddress = await this.hypXERC20Lockbox.lockbox();
    const wrappedTokenAddress = await this.getWrappedTokenAddress();
    const wrappedContract = ERC20__factory.connect(
      wrappedTokenAddress,
      this.getProvider(),
    );
    const overrides = buildBlockTagOverrides(options?.blockTag);
    const balance = await wrappedContract.balanceOf(lockboxAddress, overrides);
    return BigInt(balance.toString());
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
  extends EvmMovableCollateralAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  override async getBalance(address: Address): Promise<bigint> {
    const provider = this.getProvider();
    const balance = await provider.getBalance(address);

    return BigInt(balance.toString());
  }

  override async isApproveRequired(): Promise<boolean> {
    return false;
  }

  override async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
  }

  /**
   * Override for native token rebalancing.
   * Native adapter doesn't need USDC fee approvals since fees are paid in native token.
   * @param quotes - The quotes returned by getRebalanceQuotes
   * @param _sender - Unused for native adapter (no ERC20 approvals needed)
   */
  override async populateRebalanceTx(
    domain: Domain,
    amount: Numberish,
    bridge: Address,
    quotes: InterchainGasQuote[],
    _sender?: Address,
  ): Promise<PopulatedTransaction[]> {
    // Obtains the trx value by adding the amount of all quotes with no addressOrDenom (native tokens)
    const value = quotes.reduce(
      (v, quote) =>
        !quote.igpQuote.addressOrDenom ? v + quote.igpQuote.amount : v,
      // Uses the amount to transfer as base value given that the amount is defined in native tokens for this adapter
      BigInt(amount),
    );

    const rebalanceTx =
      await this.movableCollateral().populateTransaction.rebalance(
        domain,
        amount,
        bridge,
        { value },
      );

    return [rebalanceTx];
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<PopulatedTransaction> {
    return super.populateTransferRemoteTx(
      {
        weiAmountOrId,
        destination,
        recipient,
        interchainGas,
      },
      // Pass the amount as initial native value to the parent class
      BigInt(weiAmountOrId),
    );
  }

  override async getBridgedSupply(options?: {
    blockTag?: number | EthJsonRpcBlockParameterTag;
  }): Promise<bigint | undefined> {
    const balance = await this.getProvider().getBalance(
      this.addresses.token,
      options?.blockTag,
    );
    return BigInt(balance.toString());
  }
}

export class EvmXERC20Adapter
  extends EvmTokenAdapter
  implements IXERC20Adapter<PopulatedTransaction>
{
  xERC20: IXERC20;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.xERC20 = IXERC20__factory.connect(addresses.token, this.getProvider());
  }

  async getLimits(bridge: Address): Promise<xERC20Limits> {
    const mint = await this.xERC20.mintingMaxLimitOf(bridge);
    const burn = await this.xERC20.burningMaxLimitOf(bridge);

    return {
      mint: BigInt(mint.toString()),
      burn: BigInt(burn.toString()),
    };
  }

  async populateSetLimitsTx(
    bridge: Address,
    mint: bigint,
    burn: bigint,
  ): Promise<PopulatedTransaction> {
    return this.xERC20.populateTransaction.setLimits(
      bridge,
      mint.toString(),
      burn.toString(),
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
