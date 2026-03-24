import { type Address, type Hex, zeroAddress } from 'viem';

import {
  type Quote,
  encodeExecuteCalldata,
  encodePermit2PermitInput,
  encodePermit2TransferFromInput,
  encodeQuoteExecuteCalldata,
  encodeSubmitQuoteInput,
  encodeSweepInput,
  encodeTransferFromInput,
  encodeTransferRemoteInput,
  encodeTransferRemoteToInput,
  extractQuoteTotals,
} from './codec.js';
import type { Permit2Data, SubmitQuoteCommand } from './types.js';
import { QuotedCallsCommand, TokenPullMode } from './types.js';

/** Common params for both quoting and executing */
export interface QuotedTransferParams {
  /** QuotedCalls contract address */
  quotedCallsAddress: Address;
  /** Warp route (TokenRouter) address */
  warpRoute: Address;
  /** Destination domain ID */
  destination: number;
  /** Recipient address as bytes32 */
  recipient: Hex;
  /** Transfer amount in token wei */
  amount: bigint;
  /** ERC20 token address (zeroAddress for native token routes) */
  token: Address;
  /** Signed quotes from fee-quoting service */
  quotes: SubmitQuoteCommand[];
  /** Client salt (pre-scope) */
  clientSalt: Hex;
  /** Target router bytes32 for cross-collateral TRANSFER_REMOTE_TO */
  targetRouter?: Hex;
}

export interface QuotedCallsTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

// ============ Shared: build quote command sequence ============

/** Build the command sequence for quoteExecute (no token pull/sweep) */
function buildQuoteCommands(params: QuotedTransferParams): {
  commands: QuotedCallsCommand[];
  inputs: Hex[];
} {
  const commands: QuotedCallsCommand[] = [];
  const inputs: Hex[] = [];

  // Submit quotes
  for (const cmd of params.quotes) {
    commands.push(QuotedCallsCommand.SUBMIT_QUOTE);
    inputs.push(encodeSubmitQuoteInput(cmd, params.clientSalt));
  }

  // Transfer command (for quoting — amount matters, value/approval don't)
  if (params.targetRouter) {
    commands.push(QuotedCallsCommand.TRANSFER_REMOTE_TO);
    inputs.push(
      encodeTransferRemoteToInput({
        router: params.warpRoute,
        destination: params.destination,
        recipient: params.recipient,
        amount: params.amount,
        targetRouter: params.targetRouter,
        value: 0n,
        token: params.token,
        approval: 0n,
      }),
    );
  } else {
    commands.push(QuotedCallsCommand.TRANSFER_REMOTE);
    inputs.push(
      encodeTransferRemoteInput({
        warpRoute: params.warpRoute,
        destination: params.destination,
        recipient: params.recipient,
        amount: params.amount,
        value: 0n,
        token: params.token,
        approval: 0n,
      }),
    );
  }

  return { commands, inputs };
}

// ============ Step 1: Build quoteExecute calldata ============

/**
 * Build calldata for QuotedCalls.quoteExecute() — used via eth_call
 * to discover fee amounts before building the real execute tx.
 *
 * Commands: [SUBMIT_QUOTE×N, TRANSFER_REMOTE/TRANSFER_REMOTE_TO]
 */
export function buildQuoteCalldata(
  params: QuotedTransferParams,
): QuotedCallsTransaction {
  const { commands, inputs } = buildQuoteCommands(params);
  return {
    to: params.quotedCallsAddress,
    data: encodeQuoteExecuteCalldata(commands, inputs),
    value: 0n,
  };
}

// ============ Step 2: Build execute calldata using quote results ============

/**
 * Build calldata for QuotedCalls.execute() using fee amounts
 * from a prior quoteExecute call.
 *
 * Commands: [SUBMIT_QUOTE×N, TRANSFER_FROM/PERMIT2, TRANSFER_REMOTE, SWEEP]
 */
export function buildExecuteCalldata(
  params: QuotedTransferParams & {
    /** Fee quotes from quoteExecute (parsed Quote[][]) */
    feeQuotes: Quote[][];
    /** Token pull strategy */
    tokenPullMode: TokenPullMode;
    /** Required when tokenPullMode === Permit2 */
    permit2Data?: Permit2Data;
  },
): QuotedCallsTransaction {
  const commands: QuotedCallsCommand[] = [];
  const inputs: Hex[] = [];

  const isNativeRoute = params.token === zeroAddress;

  // The transfer command is the last command in feeQuotes
  // (index = number of quotes, since quoteExecute had [SUBMIT_QUOTE×N, TRANSFER])
  const transferCommandIndex = params.quotes.length;
  const transferQuotes = params.feeQuotes[transferCommandIndex] ?? [];

  // Extract per-command native value and token approval from the transfer quotes
  let transferNativeValue = 0n;
  let transferTokenApproval = 0n;
  for (const q of transferQuotes) {
    if (q.token === zeroAddress) {
      transferNativeValue += q.amount;
    } else {
      transferTokenApproval += q.amount;
    }
  }

  // Total ERC20 to pull = sum of all token fees across all commands
  const { nativeValue: totalNativeValue, tokenTotals } = extractQuoteTotals(
    params.feeQuotes,
  );
  const totalTokenNeeded = isNativeRoute
    ? 0n
    : (tokenTotals.get(params.token) ?? 0n);

  // 1. Submit quotes
  for (const cmd of params.quotes) {
    commands.push(QuotedCallsCommand.SUBMIT_QUOTE);
    inputs.push(encodeSubmitQuoteInput(cmd, params.clientSalt));
  }

  // 2. Token pull (skip for native routes)
  if (!isNativeRoute && totalTokenNeeded > 0n) {
    if (params.tokenPullMode === TokenPullMode.Permit2) {
      if (!params.permit2Data) {
        throw new Error('permit2Data required when tokenPullMode is Permit2');
      }
      commands.push(QuotedCallsCommand.PERMIT2_PERMIT);
      inputs.push(encodePermit2PermitInput(params.permit2Data));

      commands.push(QuotedCallsCommand.PERMIT2_TRANSFER_FROM);
      inputs.push(
        encodePermit2TransferFromInput(params.token, totalTokenNeeded),
      );
    } else {
      commands.push(QuotedCallsCommand.TRANSFER_FROM);
      inputs.push(encodeTransferFromInput(params.token, totalTokenNeeded));
    }
  }

  // 3. Transfer remote — use exact amounts from per-command quotes
  if (params.targetRouter) {
    commands.push(QuotedCallsCommand.TRANSFER_REMOTE_TO);
    inputs.push(
      encodeTransferRemoteToInput({
        router: params.warpRoute,
        destination: params.destination,
        recipient: params.recipient,
        amount: params.amount,
        targetRouter: params.targetRouter,
        value: transferNativeValue,
        token: params.token,
        approval: transferTokenApproval,
      }),
    );
  } else {
    commands.push(QuotedCallsCommand.TRANSFER_REMOTE);
    inputs.push(
      encodeTransferRemoteInput({
        warpRoute: params.warpRoute,
        destination: params.destination,
        recipient: params.recipient,
        amount: params.amount,
        value: transferNativeValue,
        token: params.token,
        approval: transferTokenApproval,
      }),
    );
  }

  // 4. Sweep leftover tokens + ETH
  commands.push(QuotedCallsCommand.SWEEP);
  inputs.push(encodeSweepInput(params.token));

  // msg.value = total native fees across all commands + transfer amount if native route
  const nativeTransferAmount = isNativeRoute ? params.amount : 0n;
  const value = totalNativeValue + nativeTransferAmount;

  return {
    to: params.quotedCallsAddress,
    data: encodeExecuteCalldata(commands, inputs),
    value,
  };
}
