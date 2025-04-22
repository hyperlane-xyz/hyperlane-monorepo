import { RefineResult } from 'arcadia-sdk-wip/types/Refine.js';

import { Address, Domain, Numberish } from '@hyperlane-xyz/utils';

import { TokenMetadata } from '../types.js';

export interface TransferParams {
  weiAmountOrId: Numberish;
  recipient: Address;
  // Required for Cosmos + Solana
  fromAccountOwner?: Address;
  // Required for Solana
  fromTokenAccount?: Address;
}

export interface TransferRemoteParams extends TransferParams {
  destination: Domain;
  interchainGas?: InterchainGasQuote;
}

export interface InterchainGasQuote {
  addressOrDenom?: string; // undefined values represent default native tokens
  amount: bigint;
}

export interface RateLimitMidPoint {
  rateLimitPerSecond: bigint;
  bufferCap: bigint;
  lastBufferUsedTime: number;
  bufferStored: bigint;
  midPoint: bigint;
}

export interface ITokenAdapter<Tx> {
  getBalance(address: Address): Promise<bigint>;
  getTotalSupply(): Promise<bigint | undefined>;
  getMetadata(isNft?: boolean): Promise<TokenMetadata>;
  getMinimumTransferAmount(recipient: Address): Promise<bigint>;
  isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean>;
  isRevokeApprovalRequired(owner: Address, spender: Address): Promise<boolean>;
  populateApproveTx(params: TransferParams): Promise<Tx>;
  populateTransferTx(params: TransferParams): Promise<Tx>;
}

export interface IMovableCollateralRouterAdapter<Tx> extends ITokenAdapter<Tx> {
  isRebalancer(address: Address): Promise<boolean>;
  isBridgeAllowed(domain: Domain, bridge: Address): Promise<boolean>;
  getAllowedDestination(domain: Domain): Promise<Address>;
  getRebalanceQuotes(
    bridge: Address,
    domain: Domain,
    recipient: Address,
    amount: Numberish,
    isWarp: boolean,
  ): Promise<InterchainGasQuote[]>;

  populateRebalanceTx(
    domain: Domain,
    amount: Numberish,
    bridge: Address,
    quotes: InterchainGasQuote[],
  ): Promise<Tx>;
}

export interface IHypTokenAdapter<Tx> extends ITokenAdapter<Tx> {
  getDomains(): Promise<Domain[]>;
  getRouterAddress(domain: Domain): Promise<Buffer>;
  getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>>;
  getBridgedSupply(): Promise<bigint | undefined>;
  // Sender is only required for Sealevel origins.
  quoteTransferRemoteGas(
    destination: Domain,
    sender?: Address,
    amount?: string,
  ): Promise<InterchainGasQuote>;
  populateTransferRemoteTx(p: TransferRemoteParams): Promise<Tx>;
}

export interface IHypXERC20Adapter<Tx> extends IHypTokenAdapter<Tx> {
  getMintLimit(): Promise<bigint>;
  getMintMaxLimit(): Promise<bigint>;

  getBurnLimit(): Promise<bigint>;
  getBurnMaxLimit(): Promise<bigint>;
}

export interface IHypVSXERC20Adapter<Tx> {
  getRateLimits(): Promise<RateLimitMidPoint>;

  populateSetBufferCapTx(newBufferCap: bigint): Promise<Tx>;
  populateSetRateLimitPerSecondTx(newRateLimitPerSecond: bigint): Promise<Tx>;

  populateAddBridgeTx(
    bufferCap: bigint,
    rateLimitPerSecond: bigint,
  ): Promise<Tx>;
}

export interface IXERC20VSAdapter<Tx> extends ITokenAdapter<Tx> {
  getRateLimits(bridge: Address): Promise<RateLimitMidPoint>;

  populateSetBufferCapTx(bridge: Address, newBufferCap: bigint): Promise<Tx>;

  populateSetRateLimitPerSecondTx(
    bridge: Address,
    newRateLimitPerSecond: bigint,
  ): Promise<Tx>;

  populateAddBridgeTx(
    bufferCap: bigint,
    rateLimitPerSecond: bigint,
    bridge: Address,
  ): Promise<Tx>;
}

export interface IEvmKhalaniIntentTokenAdapter<Tx> extends ITokenAdapter<Tx> {
  createRefine(
    sender: string,
    toChainId: number,
    amount: string,
  ): Promise<string>;
  queryRefine(refineId: string): Promise<RefineResult>;
  waitForMTokenMinting(expectedBalance: bigint, account: string): void;
  buildIntentSigningPayload(refineResult: RefineResult, account: string): any;
  proposeIntent(
    refineResult: RefineResult,
    signature: string,
  ): Promise<{
    transactionHash: string;
    intentId: string;
  }>;
}
