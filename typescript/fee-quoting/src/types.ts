import type { Address, Hex } from 'viem';

/**
 * Fee-paying commands in QuotedCalls that require offchain quotes.
 */
export enum QuotedCallsCommand {
  TransferRemote = 'transferRemote',
  TransferRemoteTo = 'transferRemoteTo',
  CallRemoteWithOverrides = 'callRemoteWithOverrides',
  CallRemoteCommitReveal = 'callRemoteCommitReveal',
}

/** Commands that require a warp fee quote (in addition to IGP) */
export const WARP_FEE_COMMANDS = new Set<QuotedCallsCommand>([
  QuotedCallsCommand.TransferRemote,
  QuotedCallsCommand.TransferRemoteTo,
]);

export interface SignedQuoteData {
  context: Hex;
  data: Hex;
  issuedAt: number;
  expiry: number;
  salt: Hex;
  submitter: Address;
}

/** SUBMIT_QUOTE command parameters for QuotedCalls.execute */
export interface SubmitQuoteCommand {
  quoter: Address;
  quote: SignedQuoteData;
  signature: Hex;
}

export interface QuoteResponse {
  quotes: SubmitQuoteCommand[];
}
