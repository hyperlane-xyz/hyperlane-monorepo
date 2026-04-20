import type { Address, Hex } from 'viem';

/** Command types matching QuotedCalls.sol constants */
export enum QuotedCallsCommand {
  SUBMIT_QUOTE = 0x00,
  PERMIT2_PERMIT = 0x01,
  PERMIT2_TRANSFER_FROM = 0x02,
  TRANSFER_FROM = 0x03,
  TRANSFER_REMOTE = 0x04,
  TRANSFER_REMOTE_TO = 0x05,
  CALL_REMOTE_WITH_OVERRIDES = 0x06,
  CALL_REMOTE_COMMIT_REVEAL = 0x07,
  SWEEP = 0x08,
}

/** Mirrors IOffchainQuoter.SignedQuote struct */
export interface SignedQuoteData {
  context: Hex;
  data: Hex;
  issuedAt: number;
  expiry: number;
  salt: Hex;
  submitter: Address;
}

/** SUBMIT_QUOTE command parameters — matches fee-quoting service response */
export interface SubmitQuoteCommand {
  quoter: Address;
  quote: SignedQuoteData;
  signature: Hex;
}

/** How tokens are pulled into QuotedCalls contract */
export enum TokenPullMode {
  /** Standard ERC20 transferFrom — requires prior approval to QuotedCalls */
  TransferFrom = 'transferFrom',
  /** Permit2 allowance transfer — uses signed permit, no prior approval needed */
  Permit2 = 'permit2',
}

/** Permit2 PermitSingle + signature for PERMIT2_PERMIT command */
export interface Permit2Data {
  permitSingle: {
    details: {
      token: Address;
      amount: bigint;
      expiration: number;
      nonce: number;
    };
    spender: Address;
    sigDeadline: number;
  };
  signature: Hex;
}

/**
 * Fee-paying commands in QuotedCalls that require offchain quotes.
 * String values correspond to the fee-quoting service API routes.
 */
export enum FeeQuotingCommand {
  TransferRemote = 'transferRemote',
  TransferRemoteTo = 'transferRemoteTo',
  CallRemoteWithOverrides = 'callRemoteWithOverrides',
  CallRemoteCommitReveal = 'callRemoteCommitReveal',
}

/** Commands that require a warp fee quote (in addition to IGP) */
export const WARP_FEE_COMMANDS = new Set<FeeQuotingCommand>([
  FeeQuotingCommand.TransferRemote,
  FeeQuotingCommand.TransferRemoteTo,
]);

export interface FeeQuotingQuoteResponse {
  quotes: SubmitQuoteCommand[];
}

/** Parameters for building a QuotedCalls transfer via WarpCore */
export interface QuotedCallsParams {
  /** QuotedCalls contract address */
  address: Address;
  /** Signed quotes from fee-quoting service */
  quotes: SubmitQuoteCommand[];
  /** Client salt (pre-scope — QuotedCalls applies keccak256(msg.sender, clientSalt)) */
  clientSalt: Hex;
  /** Token pull strategy */
  tokenPullMode: TokenPullMode;
  /** Required when tokenPullMode === Permit2 */
  permit2Data?: Permit2Data;
  /** Pre-computed fee quotes from getQuotedTransferFee. If provided, skips quoteExecute eth_call. */
  feeQuotes?: Array<Array<{ token: Address; amount: bigint }>>;
}
