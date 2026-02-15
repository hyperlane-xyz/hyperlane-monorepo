import { PopulatedTransaction } from 'ethers';
import { ethers } from 'ethers';

// TODO: Replace with actual types from @hyperlane-xyz/core once Solidity contracts are compiled
import {
  HypPrivate,
  HypPrivateCollateral,
  HypPrivateCollateral__factory,
  HypPrivateNative,
  HypPrivateNative__factory,
  HypPrivateSynthetic,
  HypPrivateSynthetic__factory,
} from './PrivateContractTypes.js';
import {
  Address,
  Domain,
  addressToBytes32,
  assert,
  normalizeAddress,
} from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import {
  EvmHypCollateralAdapter,
  EvmHypSyntheticAdapter,
} from './EvmTokenAdapter.js';
import { IHypTokenAdapter } from './ITokenAdapter.js';

export interface AleoWalletAdapter {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
  signTransaction(tx: any): Promise<string>;
}

export interface PrivateDepositParams {
  secret: string; // 32-byte hex string (with or without 0x)
  finalDestination: Domain;
  recipient: Address;
  amount: bigint;
  aleoWallet?: AleoWalletAdapter;
}

export interface PrivateDepositResult {
  messageId: string;
  commitment: string;
  nonce: number;
  aleoRegistrationRequired?: boolean;
}

export interface UserRegistrationInfo {
  isRegistered: boolean;
  aleoAddress?: string;
  registrationKey?: string;
}

/**
 * Base adapter for privacy warp routes on origin chains
 * Handles deposits to Aleo privacy hub
 */
export abstract class BasePrivateWarpOriginAdapter<T extends HypPrivate>
  extends BaseEvmAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  public readonly contract: T;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    contractFactory: any,
  ) {
    super(chainName, multiProvider, addresses);
    this.contract = contractFactory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  // ITokenAdapter methods - delegate to collateral/synthetic adapter
  abstract getBalance(address: Address): Promise<bigint>;
  abstract getMetadata(isNft?: boolean): Promise<any>;
  abstract getTotalSupply(): Promise<bigint | undefined>;
  abstract getMinimumTransferAmount(recipient: Address): Promise<bigint>;
  abstract isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: any,
  ): Promise<boolean>;
  abstract isRevokeApprovalRequired(
    owner: Address,
    spender: Address,
  ): Promise<boolean>;
  abstract populateApproveTx(params: any): Promise<PopulatedTransaction>;
  abstract populateTransferTx(params: any): Promise<PopulatedTransaction>;

  // IHypTokenAdapter methods
  async getDomains(): Promise<Domain[]> {
    return this.contract.domains();
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const routerBytes32 = await this.contract.routers(domain);
    return Buffer.from(routerBytes32.slice(2), 'hex');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const domains = await this.getDomains();
    const routers = await Promise.all(
      domains.map((d) => this.getRouterAddress(d)),
    );
    return domains.map((d, i) => ({ domain: d, address: routers[i] }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    // Privacy routes don't expose bridged supply
    return undefined;
  }

  async quoteTransferRemoteGas(params: any): Promise<any> {
    const gasPayment = await this.contract.quoteGasPayment(params.destination);
    return { igpQuote: { amount: BigInt(gasPayment.toString()) } };
  }

  async populateTransferRemoteTx(_params: any): Promise<PopulatedTransaction> {
    throw new Error(
      'Use depositPrivate() for privacy transfers. Standard transferRemote not supported.',
    );
  }

  // Privacy-specific methods

  /**
   * Get Aleo privacy hub configuration
   */
  async getAleoConfig(): Promise<{ hub: string; domain: number }> {
    const [hub, domain] = await Promise.all([
      this.contract.aleoPrivacyHub(),
      this.contract.aleoDomain(),
    ]);
    return { hub, domain };
  }

  /**
   * Get current commitment nonce
   */
  async getCurrentNonce(): Promise<number> {
    const nonce = await this.contract.commitmentNonce();
    return nonce.toNumber();
  }

  /**
   * Check if commitment has been used
   */
  async isCommitmentUsed(commitment: string): Promise<boolean> {
    return this.contract.isCommitmentUsed(commitment);
  }

  /**
   * Get enrolled router for destination
   */
  async getRemoteRouter(domain: Domain): Promise<string> {
    return this.contract.getRemoteRouter(domain);
  }

  /**
   * Enroll remote router (owner only)
   */
  async populateEnrollRemoteRouterTx(
    domain: Domain,
    router: string,
  ): Promise<PopulatedTransaction> {
    return this.contract.populateTransaction.enrollRemoteRouter(domain, router);
  }

  /**
   * Compute commitment hash (matches Solidity)
   */
  computeCommitment(
    secret: string,
    recipient: string,
    amount: bigint,
    destinationDomain: number,
    destinationRouter: string,
    nonce: number,
  ): string {
    // Normalize inputs
    const secretBytes32 = this.normalizeBytes32(secret);
    const recipientBytes32 = addressToBytes32(recipient);
    const routerBytes32 = this.normalizeBytes32(destinationRouter);

    // Use solidityKeccak256 to match Solidity's keccak256(abi.encode(...))
    return ethers.utils.solidityKeccak256(
      ['bytes32', 'bytes32', 'uint256', 'uint32', 'bytes32', 'uint256'],
      [
        secretBytes32,
        recipientBytes32,
        amount,
        destinationDomain,
        routerBytes32,
        nonce,
      ],
    );
  }

  /**
   * Check if user is registered on Aleo privacy hub
   * @param originChain - Origin chain domain ID
   * @param originAddress - User's address on origin chain
   */
  async checkRegistration(
    originChain: number,
    originAddress: Address,
  ): Promise<UserRegistrationInfo> {
    // This requires Aleo RPC access - implementation depends on Aleo SDK
    // For now, return a stub that indicates registration check needed
    const registrationKey = this.computeRegistrationKey(
      originChain,
      originAddress,
    );

    return {
      isRegistered: false, // Requires Aleo RPC call
      registrationKey,
    };
  }

  /**
   * Deposit tokens for private transfer via Aleo
   * @param params - Deposit parameters including secret, destination, recipient, amount
   * @returns Transaction details including commitment and nonce
   */
  async populateDepositPrivateTx(
    params: PrivateDepositParams,
  ): Promise<{ tx: PopulatedTransaction; commitment: string; nonce: number }> {
    // Validate inputs
    assert(
      params.secret.length === 66 || params.secret.length === 64,
      'Secret must be 32 bytes',
    );
    assert(params.amount > 0n, 'Amount must be positive');
    assert(params.amount <= 2n ** 128n - 1n, 'Amount exceeds u128 max');

    // Check destination router enrolled
    const destinationRouter = await this.getRemoteRouter(
      params.finalDestination,
    );
    assert(
      destinationRouter !== ethers.constants.HashZero,
      `Router not enrolled for destination ${params.finalDestination}`,
    );

    // Get current nonce
    const nonce = await this.getCurrentNonce();

    // Compute commitment
    const secretBytes32 = this.normalizeBytes32(params.secret);
    const recipientBytes32 = addressToBytes32(params.recipient);
    const commitment = this.computeCommitment(
      secretBytes32,
      recipientBytes32,
      params.amount,
      params.finalDestination,
      destinationRouter,
      nonce,
    );

    // Check commitment not already used
    const used = await this.isCommitmentUsed(commitment);
    assert(!used, `Commitment already used: ${commitment}`);

    // Get gas quote for Aleo
    const { domain: aleoDomain } = await this.getAleoConfig();
    const gasPayment = await this.contract.quoteGasPayment(aleoDomain);

    // Populate transaction
    // Note: depositPrivate method must be defined in contract interface
    const tx: PopulatedTransaction = {
      to: this.contract.address,
      data: this.contract.interface.encodeFunctionData('depositPrivate', [
        secretBytes32,
        params.finalDestination,
        recipientBytes32,
      ]),
      value: ethers.BigNumber.from(
        this.getDepositValue(params.amount, gasPayment).toString(),
      ),
    };

    return { tx, commitment, nonce };
  }

  /**
   * Get total value to send with deposit (amount + gas)
   * Override for native vs collateral
   */
  protected abstract getDepositValue(amount: bigint, gasPayment: any): bigint;

  /**
   * Normalize hex string to bytes32 format
   */
  protected normalizeBytes32(value: string): string {
    let hex = value;
    if (!hex.startsWith('0x')) {
      hex = '0x' + hex;
    }
    assert(hex.length === 66, `Invalid bytes32 length: ${hex.length}`);
    return hex;
  }

  /**
   * Compute registration key (matches Aleo program)
   */
  private computeRegistrationKey(chain: number, address: Address): string {
    const normalizedAddr = normalizeAddress(address);
    const addrBytes32 = addressToBytes32(normalizedAddr);

    // Pack chain ID (4 bytes) + address (32 bytes)
    const packed = ethers.utils.solidityPack(
      ['uint32', 'bytes32'],
      [chain, addrBytes32],
    );

    return ethers.utils.keccak256(packed);
  }
}

/**
 * Adapter for HypPrivateNative contracts
 */
export class EvmHypPrivateNativeAdapter extends BasePrivateWarpOriginAdapter<HypPrivateNative> {
  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses, HypPrivateNative__factory);
  }

  async getBalance(address: Address): Promise<bigint> {
    const balance = await this.getProvider().getBalance(address);
    return BigInt(balance.toString());
  }

  async getMetadata(): Promise<any> {
    const { nativeToken } = this.multiProvider.getChainMetadata(this.chainName);
    assert(nativeToken, `Native token data required for ${this.chainName}`);
    return {
      name: nativeToken.name,
      symbol: nativeToken.symbol,
      decimals: nativeToken.decimals,
    };
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    return undefined; // Native tokens don't have accessible total supply
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  async isRevokeApprovalRequired(): Promise<boolean> {
    return false;
  }

  async populateApproveTx(_params: any): Promise<PopulatedTransaction> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx(params: any): Promise<PopulatedTransaction> {
    const value = BigInt(params.weiAmountOrId.toString());
    return {
      value: ethers.BigNumber.from(value.toString()),
      to: params.recipient,
    };
  }

  protected getDepositValue(amount: bigint, gasPayment: any): bigint {
    return amount + BigInt(gasPayment.toString());
  }

  async getCollateralBalance(): Promise<bigint> {
    const balance = await this.getProvider().getBalance(this.addresses.token);
    return BigInt(balance.toString());
  }
}

/**
 * Adapter for HypPrivateCollateral contracts
 */
export class EvmHypPrivateCollateralAdapter extends BasePrivateWarpOriginAdapter<HypPrivateCollateral> {
  private collateralAdapter: EvmHypCollateralAdapter;

  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses, HypPrivateCollateral__factory);
    this.collateralAdapter = new EvmHypCollateralAdapter(
      chainName,
      multiProvider,
      addresses,
    );
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.collateralAdapter.getBalance(address);
  }

  async getMetadata(isNft?: boolean): Promise<any> {
    return this.collateralAdapter.getMetadata(isNft);
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    return this.collateralAdapter.getTotalSupply();
  }

  async getMinimumTransferAmount(recipient: Address): Promise<bigint> {
    return this.collateralAdapter.getMinimumTransferAmount(recipient);
  }

  async isApproveRequired(
    owner: Address,
    spender: Address,
    amount: any,
  ): Promise<boolean> {
    return this.collateralAdapter.isApproveRequired(owner, spender, amount);
  }

  async isRevokeApprovalRequired(
    owner: Address,
    spender: Address,
  ): Promise<boolean> {
    return this.collateralAdapter.isRevokeApprovalRequired(owner, spender);
  }

  async populateApproveTx(params: any): Promise<PopulatedTransaction> {
    return this.collateralAdapter.populateApproveTx(params);
  }

  async populateTransferTx(params: any): Promise<PopulatedTransaction> {
    return this.collateralAdapter.populateTransferTx(params);
  }

  protected getDepositValue(_amount: bigint, gasPayment: any): bigint {
    return BigInt(gasPayment.toString()); // Only gas, no native token
  }

  async getCollateralBalance(): Promise<bigint> {
    return this.contract.collateralBalance();
  }

  async getWrappedTokenAddress(): Promise<Address> {
    return this.contract.token();
  }

  async populateTransferRemoteCollateralTx(
    destination: Domain,
    amount: bigint,
  ): Promise<PopulatedTransaction> {
    const gasPayment = await this.contract.quoteGasPayment(destination);
    return this.contract.populateTransaction.transferRemoteCollateral(
      destination,
      amount,
      {
        value: gasPayment,
      },
    );
  }
}

/**
 * Adapter for HypPrivateSynthetic contracts
 */
export class EvmHypPrivateSyntheticAdapter extends BasePrivateWarpOriginAdapter<HypPrivateSynthetic> {
  private syntheticAdapter: EvmHypSyntheticAdapter;

  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses, HypPrivateSynthetic__factory);
    this.syntheticAdapter = new EvmHypSyntheticAdapter(
      chainName,
      multiProvider,
      addresses,
    );
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.syntheticAdapter.getBalance(address);
  }

  async getMetadata(isNft?: boolean): Promise<any> {
    return this.syntheticAdapter.getMetadata(isNft);
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    return this.syntheticAdapter.getTotalSupply();
  }

  async getMinimumTransferAmount(recipient: Address): Promise<bigint> {
    return this.syntheticAdapter.getMinimumTransferAmount(recipient);
  }

  async isApproveRequired(): Promise<boolean> {
    return false; // Synthetic tokens are burned, no approval needed
  }

  async isRevokeApprovalRequired(): Promise<boolean> {
    return false;
  }

  async populateApproveTx(_params: any): Promise<PopulatedTransaction> {
    throw new Error('Approve not required for synthetic tokens');
  }

  async populateTransferTx(params: any): Promise<PopulatedTransaction> {
    return this.syntheticAdapter.populateTransferTx(params);
  }

  protected getDepositValue(_amount: bigint, gasPayment: any): bigint {
    return BigInt(gasPayment.toString()); // Only gas, no native token
  }
}
