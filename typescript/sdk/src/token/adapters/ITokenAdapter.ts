import { Address, Domain, Numberish } from '@hyperlane-xyz/utils';

import { MinimalTokenMetadata } from '../config';

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
  interchainGas?: InterchainFeeQuote;
}

export interface InterchainFeeQuote {
  addressOrDenom?: string; // undefined values represent default native tokens
  amount: bigint;
}

export interface ITokenAdapter<Tx> {
  getBalance(address: Address): Promise<bigint>;
  getMetadata(isNft?: boolean): Promise<MinimalTokenMetadata>;
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
  quoteTransferRemoteFee(destination: Domain): Promise<InterchainFeeQuote>;
  populateTransferRemoteTx(p: TransferRemoteParams): Promise<Tx>;
}
