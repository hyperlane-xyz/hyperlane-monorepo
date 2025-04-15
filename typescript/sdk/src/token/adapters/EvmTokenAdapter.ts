//import { PERMIT2_ADDRESS } from '@uniswap/permit2-sdk';
import { ArcadiaSDK } from 'arcadia-sdk-wip';
import { BigNumber, PopulatedTransaction, ethers } from 'ethers';

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
  IXERC20VS,
  IXERC20VS__factory,
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
  IEvmKhalaniIntentTokenAdapter,
  IHypTokenAdapter,
  IHypVSXERC20Adapter,
  IHypXERC20Adapter,
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
  //public contract;
  private arcadiaProvider: ethers.providers.JsonRpcProvider;
  private mTokenContract;
  private assetReservesContract;
  private intentBookContract;
  // private intentService;
  private refineService;
  private chainId;
  private medusaAPIUrl;
  // private medusaProvider;

  private readonly khalaniChainId = 1098411886;
  private readonly intentBookAddress =
    '0xefb06bc8b3dfa82774210E50EE39F934D088621a';

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      token: Address;
      assetReserves: Address;
      addressOrDenom: Address;
    },
  ) {
    super(chainName, multiProvider, addresses);
    // this.contract = this.contractFactory.connect(
    //   addresses.token,
    //   this.getProvider(),
    // );

    this.chainId = Number(this.multiProvider.getChainId(chainName));
    const chainProvider = this.multiProvider.getEthersV5Provider(chainName);
    const arcadiaSdk = new ArcadiaSDK('EthersV5');
    const walletService = arcadiaSdk.walletService;
    const contractService = arcadiaSdk.contractService;
    //this.intentService = arcadiaSdk.intentService;
    this.refineService = arcadiaSdk.refineService;
    this.medusaAPIUrl = walletService.getMedusaRPCUrl();

    // instantiate arcadia provider
    const arcadiaChainInfo = walletService.getArcadiaChainInfo();
    this.arcadiaProvider = new ethers.providers.JsonRpcProvider(
      arcadiaChainInfo.rpcUrl[0],
    );

    // instantiate medusa provider
    // this.medusaProvider = new ethers.providers.JsonRpcProvider(
    //   walletService.getMedusaRPCUrl(),
    // );

    // instantiate assetReserves
    this.assetReservesContract = new ethers.Contract(
      this.addresses.assetReserves,
      contractService.getAssetReservesABI(),
      chainProvider,
    ) as ethers.Contract & {
      deposit: (
        token: string,
        amount: ethers.BigNumber,
        destChain: number,
        permitNonce: ethers.BigNumber,
        deadline: ethers.BigNumber,
        signature: string,
        overrides?: ethers.PayableOverrides,
      ) => Promise<ethers.ContractTransaction>;
    };

    // instantiate intentBook
    this.intentBookContract = new ethers.Contract(
      this.intentBookAddress,
      [
        {
          inputs: [{ name: '_user', type: 'address', internalType: 'address' }],
          name: 'getNonce',
          outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        },
      ],
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

  async getBalance(address: Address): Promise<bigint> {
    const balance = await this.contract.balanceOf(address);
    return BigInt(balance.toString());
  }

  async createRefine(
    sender: string,
    toChainId: number,
    amount: string,
  ): Promise<string> {
    const currentNonce = await this.intentBookContract.getNonce(sender);

    const refinePayload: any = this.refineService.buildCreateRefinePayload({
      accountAddress: sender,
      fromChainId: this.chainId,
      fromTokenAddress: this.addresses.token,
      amount: BigInt(amount),
      toChainId,
      toTokenAddress: '0x6711C699d048Eb2e46a7519eA8506041c2E91D6B', // TODO: replace once we have a helper from the SDK. hardcoded to op-sepolia for now.
      currentNonce: BigInt(currentNonce.add(1).toString()),
    });

    const response = await fetch(this.medusaAPIUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(refinePayload.jsonRpcObject),
    });

    const refine = await response.json();
    return refine.result;
  }

  async isApproveRequired(
    owner: Address,
    _spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    const allowance = await this.contract.allowance(
      owner,
      '0x1f94605b30713bbb0b5314b4fceab89cce646018', // TODO: replace
    );
    return allowance.lt(weiAmountOrId);
  }

  async populateTransferTx({
    weiAmountOrId,
  }: TransferParams): Promise<PopulatedTransaction> {
    const privateKey = '';
    const wallet = new ethers.Wallet(privateKey);

    const permitDomain = {
      name: 'Permit2',
      chainId: this.chainId,
      verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    };

    const permitTypes = {
      PermitTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    };

    const nonce = BigInt(new Date().getTime());
    const deadline = ethers.constants.MaxUint256;

    const permitMessage = {
      permitted: {
        token: this.contract.address,
        amount: BigNumber.from(weiAmountOrId),
      },
      spender: this.addresses.assetReserves,
      nonce,
      deadline,
    };

    const signature = await wallet._signTypedData(
      permitDomain,
      permitTypes,
      permitMessage,
    );

    return this.assetReservesContract.populateTransaction.deposit(
      this.contract.address,
      BigNumber.from(weiAmountOrId),
      this.khalaniChainId,
      nonce,
      deadline,
      signature,
    );
  }

  async getMTokensBalance(): Promise<bigint> {
    const balance = await this.mTokenContract.balanceOf(this.addresses.token);
    return BigInt(balance.toString());
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
      assetReserves: Address;
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
    //const refineId =
    await this.createRefine(_sender, _destination, amount);

    // TODO: call pollRefine to get refine data

    return {
      amount: 2000000000000000n,
      addressOrDenom: this.addresses.addressOrDenom,
    };
  }

  populateTransferRemoteTx(
    _p: TransferRemoteParams,
  ): Promise<PopulatedTransaction> {
    return this.populateTransferTx(_p);
  }
}
