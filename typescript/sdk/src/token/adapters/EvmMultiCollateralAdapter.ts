import { PopulatedTransaction } from 'ethers';

import {
  ERC20__factory,
  MultiCollateral,
  MultiCollateral__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  Numberish,
  addressToBytes32,
} from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  InterchainGasQuote,
  QuoteTransferRemoteParams,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

/**
 * Adapter for MultiCollateral routers.
 * Supports transferRemoteTo (cross-chain to specific router) and
 * localTransferTo (same-chain swap).
 */
export class EvmHypMultiCollateralAdapter
  extends BaseEvmAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  public readonly contract: MultiCollateral;
  public readonly collateralToken: Address;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      token: Address; // router address
      collateralToken: Address; // underlying ERC20
    },
  ) {
    super(chainName, multiProvider, addresses);
    this.contract = MultiCollateral__factory.connect(
      addresses.token,
      this.getProvider(),
    );
    this.collateralToken = addresses.collateralToken;
  }

  async getBalance(address: Address): Promise<bigint> {
    const erc20 = ERC20__factory.connect(
      this.collateralToken,
      this.getProvider(),
    );
    const balance = await erc20.balanceOf(address);
    return BigInt(balance.toString());
  }

  async getMetadata(): Promise<TokenMetadata> {
    const erc20 = ERC20__factory.connect(
      this.collateralToken,
      this.getProvider(),
    );
    const [decimals, symbol, name] = await Promise.all([
      erc20.decimals(),
      erc20.symbol(),
      erc20.name(),
    ]);
    return { decimals, symbol, name };
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const erc20 = ERC20__factory.connect(
      this.collateralToken,
      this.getProvider(),
    );
    const totalSupply = await erc20.totalSupply();
    return BigInt(totalSupply.toString());
  }

  async isApproveRequired(
    owner: Address,
    _spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    const erc20 = ERC20__factory.connect(
      this.collateralToken,
      this.getProvider(),
    );
    const allowance = await erc20.allowance(owner, this.addresses.token);
    return allowance.lt(weiAmountOrId);
  }

  async isRevokeApprovalRequired(
    owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    const erc20 = ERC20__factory.connect(
      this.collateralToken,
      this.getProvider(),
    );
    const allowance = await erc20.allowance(owner, this.addresses.token);
    return !allowance.isZero();
  }

  async populateApproveTx({
    weiAmountOrId,
  }: TransferParams): Promise<PopulatedTransaction> {
    const erc20 = ERC20__factory.connect(
      this.collateralToken,
      this.getProvider(),
    );
    return erc20.populateTransaction.approve(
      this.addresses.token,
      weiAmountOrId.toString(),
    );
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    const erc20 = ERC20__factory.connect(
      this.collateralToken,
      this.getProvider(),
    );
    return erc20.populateTransaction.transfer(
      recipient,
      weiAmountOrId.toString(),
    );
  }

  async getDomains(): Promise<Domain[]> {
    const domains = await this.contract.domains();
    return domains.map(Number);
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const router = await this.contract.routers(domain);
    return Buffer.from(router.slice(2), 'hex');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const domains = await this.getDomains();
    return Promise.all(
      domains.map(async (domain) => ({
        domain,
        address: await this.getRouterAddress(domain),
      })),
    );
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    const erc20 = ERC20__factory.connect(
      this.collateralToken,
      this.getProvider(),
    );
    const balance = await erc20.balanceOf(this.addresses.token);
    return BigInt(balance.toString());
  }

  // Standard transferRemote (same-stablecoin, uses enrolled remote router)
  async populateTransferRemoteTx(
    params: TransferRemoteParams,
  ): Promise<PopulatedTransaction> {
    const recipientBytes32 = addressToBytes32(params.recipient);
    const gasPayment = await this.contract.quoteGasPayment(params.destination);
    return this.contract.populateTransaction.transferRemote(
      params.destination,
      recipientBytes32,
      params.weiAmountOrId.toString(),
      { value: gasPayment },
    );
  }

  async quoteTransferRemoteGas(
    params: QuoteTransferRemoteParams,
  ): Promise<InterchainGasQuote> {
    const gasPayment = await this.contract.quoteGasPayment(params.destination);
    return {
      igpQuote: { amount: BigInt(gasPayment.toString()) },
    };
  }

  // ============ MultiCollateral-specific methods ============

  /**
   * Populate cross-chain transfer to a specific target router.
   */
  async populateTransferRemoteToTx(params: {
    destination: Domain;
    recipient: Address;
    amount: Numberish;
    targetRouter: Address;
  }): Promise<PopulatedTransaction> {
    const recipientBytes32 = addressToBytes32(params.recipient);
    const targetRouterBytes32 = addressToBytes32(params.targetRouter);

    // Quote gas
    const quotes = await this.contract.quoteTransferRemoteTo(
      params.destination,
      recipientBytes32,
      params.amount.toString(),
      targetRouterBytes32,
    );
    const nativeGas = quotes[0].amount;

    return this.contract.populateTransaction.transferRemoteTo(
      params.destination,
      recipientBytes32,
      params.amount.toString(),
      targetRouterBytes32,
      { value: nativeGas },
    );
  }

  /**
   * Populate same-chain local transfer to an enrolled router.
   */
  async populateLocalTransferToTx(params: {
    targetRouter: Address;
    recipient: Address;
    amount: Numberish;
  }): Promise<PopulatedTransaction> {
    return this.contract.populateTransaction.localTransferTo(
      params.targetRouter,
      params.recipient,
      params.amount.toString(),
    );
  }

  /**
   * Quote fees for transferRemoteTo.
   */
  async quoteTransferRemoteToGas(params: {
    destination: Domain;
    recipient: Address;
    amount: Numberish;
    targetRouter: Address;
  }): Promise<InterchainGasQuote> {
    const recipientBytes32 = addressToBytes32(params.recipient);
    const targetRouterBytes32 = addressToBytes32(params.targetRouter);

    const quotes = await this.contract.quoteTransferRemoteTo(
      params.destination,
      recipientBytes32,
      params.amount.toString(),
      targetRouterBytes32,
    );

    return {
      igpQuote: { amount: BigInt(quotes[0].amount.toString()) },
    };
  }
}
