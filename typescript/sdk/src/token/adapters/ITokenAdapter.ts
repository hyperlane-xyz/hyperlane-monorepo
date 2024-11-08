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

export interface ITokenAdapter<Tx> {
  getBalance(address: Address): Promise<bigint>;
  getTotalSupply(): Promise<bigint | undefined>;
  getMetadata(isNft?: boolean): Promise<TokenMetadata>;
  isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean>;
  populateApproveTx(params: TransferParams): Promise<Tx>;
  populateTransferTx(params: TransferParams): Promise<Tx>;
}

export interface IHypTokenAdapter<Tx> extends ITokenAdapter<Tx> {
  getDomains(): Promise<Domain[]>;
  getRouterAddress(domain: Domain): Promise<Buffer>;
  getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>>;
  getBridgedSupply(): Promise<bigint | undefined>;
  quoteTransferRemoteGas(destination: Domain): Promise<InterchainGasQuote>;
  populateTransferRemoteTx(p: TransferRemoteParams): Promise<Tx>;
}

export interface IHypXERC20Adapter<Tx> extends IHypTokenAdapter<Tx> {
  getMintLimit(): Promise<bigint>;
  getMintMaxLimit(): Promise<bigint>;

  getBurnLimit(): Promise<bigint>;
  getBurnMaxLimit(): Promise<bigint>;
}
